import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {INestApplication} from '@nestjs/common';
import type {TestingModuleBuilder} from '@nestjs/testing';
import {MikroORM} from '@mikro-orm/postgresql';
import {DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand} from '@aws-sdk/client-sqs';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {openWallet} from '../support/fixtures.js';
import {buildApp, createTestQueues, flakySqs, queueDepth, receiveAll, sendWagerMessage, sleep, sqs} from '../support/sqs.js';
import {WagerConsumer} from '../../src/messaging/wagerConsumer.js';
import {SQS_CLIENT} from '../../src/messaging/sqs.provider.js';
import {messagingConfig} from '../../src/messaging/messaging.config.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';

let orm: MikroORM;
let queues: Awaited<ReturnType<typeof createTestQueues>>;
let apps: INestApplication[] = [];

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const txRows = () => rows(`SELECT status, failure_code FROM wager_transactions WHERE kind <> 'OPENING' ORDER BY created_at`);
const debits = async (walletId: string) =>
    Number((await rows(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0].n);

type Wallet = { walletId: string; playerId: string };
// A BET of 10.00 as a provider would put it on the queue (README §10).
const wagerBody = (w: Wallet, over: { messageId?: string, data?: object } = {}) => {
    const id = randomUUID();
    return {
        messageId: over.messageId ?? `msg-${id}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
        data: {
            providerId: 'prov-1', externalTransactionId: `ext-${id}`, idempotencyKey: `key-${id}`, playerId: w.playerId,
            walletId: w.walletId, roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: {amount: '10.00', currency: 'BRL'},
            ...over.data,
        },
    };
};
const sendRaw = (body: string) => sqs.send(new SendMessageCommand({
    QueueUrl: queues.wagerQueueUrl, MessageBody: body, MessageGroupId: 'raw', MessageDeduplicationId: randomUUID(),
}));

const start = async (overrides?: (b: TestingModuleBuilder) => TestingModuleBuilder) => {
    const app = await buildApp({queues, overrides});
    apps.push(app);
    return {app, consumer: app.get(WagerConsumer)};
};
const poll = (consumer: WagerConsumer) => consumer.pollOnce(1);
const visibilityTimeout = () => sleep(2200);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => orm.close());
beforeEach(async () => {
    await truncateAll(orm);
    queues = await createTestQueues();   // fresh queues per test: nothing left over hides behind a visibility timeout
});
afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps = [];
});

describe('WagerConsumer against real SQS', () => {
    it('a valid message is processed and gone from the queue', async () => {
        const w = await openWallet(orm, '100.00');
        const { consumer } = await start();
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));

        await poll(consumer);

        expect(await txRows()).toEqual([{status: 'PROCESSED', failure_code: null}]);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        expect(await queueDepth(queues.wagerDlqUrl)).toBe(0);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('the same messageId delivered twice makes one debit (inbox)', async () => {
        const w = await openWallet(orm, '100.00');
        const { consumer } = await start();
        const body = wagerBody(w);
        await sendWagerMessage(queues.wagerQueueUrl, body);
        await sendWagerMessage(queues.wagerQueueUrl, body, randomUUID());   // another dedup id: the broker lets it through

        await poll(consumer);

        expect(await debits(w.walletId)).toBe(1);
        expect(await count('inbox_messages')).toBe(1);
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('the same business transaction under a different messageId is replayed by idempotency: no second debit', async () => {
        const w = await openWallet(orm, '100.00');
        const { consumer } = await start();
        const first = wagerBody(w);
        await sendWagerMessage(queues.wagerQueueUrl, first);
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w, {data: first.data}));

        await poll(consumer);

        expect(await debits(w.walletId)).toBe(1);
        expect(await count('inbox_messages')).toBe(2);
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('worker dies after the commit, before the delete: redelivered, no duplicate effect', async () => {
        const w = await openWallet(orm, '100.00');
        const { consumer } = await start((b) => b.overrideProvider(SQS_CLIENT).useValue(flakySqs((c) => c instanceof DeleteMessageCommand, 1)));
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));

        await poll(consumer);
        expect(await balanceOf(w.walletId)).toBe('90.00');                  // committed
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(1);             // but not deleted

        await visibilityTimeout();
        await poll(consumer);                                               // second delivery: inbox says duplicate, acked

        expect(await debits(w.walletId)).toBe(1);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        expect(await queueDepth(queues.wagerDlqUrl)).toBe(0);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('a malformed message lands in the DLQ with its original body; the main queue is empty', async () => {
        const { consumer } = await start();
        await sendRaw('{not json');

        await poll(consumer);

        const [dead] = await receiveAll(queues.wagerDlqUrl);
        expect(dead.Body).toBe('{not json');
        expect(dead.MessageAttributes?.errorType.StringValue).toBe('SyntaxError');
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
    });

    it('a permanently invalid message (unknown wallet) lands in the DLQ and changes nothing', async () => {
        const { consumer } = await start();
        const body = wagerBody({walletId: randomUUID(), playerId: randomUUID()});
        await sendWagerMessage(queues.wagerQueueUrl, body);

        await poll(consumer);

        const [dead] = await receiveAll(queues.wagerDlqUrl);
        expect(JSON.parse(dead.Body!)).toEqual(body);
        expect(dead.MessageAttributes?.errorType.StringValue).toBe('WalletNotFoundError');
        expect(await count('wager_transactions')).toBe(0);
        expect(await count('wallets')).toBe(0);
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
    });

    it('the same messageId with different content is permanent: DLQ, one effect', async () => {
        const w = await openWallet(orm, '100.00');
        const { consumer } = await start();
        const first = wagerBody(w);
        await sendWagerMessage(queues.wagerQueueUrl, first);
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w, {messageId: first.messageId, data: {money: {amount: '99.00', currency: 'BRL'}}}), randomUUID());

        await poll(consumer);

        const [dead] = await receiveAll(queues.wagerDlqUrl);
        expect(dead.MessageAttributes?.errorType.StringValue).toBe('InboxPayloadMismatchError');
        expect(await debits(w.walletId)).toBe(1);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('a business rejection is acked: REJECTED row, nothing in the DLQ', async () => {
        const w = await openWallet(orm, '5.00');
        const { consumer } = await start();
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));

        await poll(consumer);

        expect(await txRows()).toEqual([{status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS'}]);
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        expect(await queueDepth(queues.wagerDlqUrl)).toBe(0);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    // Each failed receive hides the message for the 2 s visibility timeout, hence the waits.
    it('a transient failure on every attempt: DLQ after the last receive with a FAILED row; a redrive replays it', { timeout: 60_000 }, async () => {
        const w = await openWallet(orm, '100.00');
        const broken = Object.assign(Object.create(new InboxRepository()), {   // fails the business call only; recordFailure never touches the inbox
            tryInsert: async () => { throw new Error('connection reset'); },
        });
        const { consumer } = await start((b) => b.overrideProvider(InboxRepository).useValue(broken));
        const body = wagerBody(w);
        await sendWagerMessage(queues.wagerQueueUrl, body);

        const max = messagingConfig().wagerMaxReceiveCount;
        for (let receive = 1; receive <= max; receive++) {
            await poll(consumer);
            if (receive < max) {
                expect(await queueDepth(queues.wagerDlqUrl)).toBe(0);
                expect(await queueDepth(queues.wagerQueueUrl)).toBe(1);
                await visibilityTimeout();
            }
        }

        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        const [dead] = await receiveAll(queues.wagerDlqUrl);
        expect(JSON.parse(dead.Body!)).toEqual(body);
        expect(await txRows()).toEqual([{status: 'FAILED', failure_code: 'PROCESSING_ERROR'}]);
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);

        // The fault is gone. Redriving the dead message replays FAILED: no second effect.
        const healthy = await start();
        await sendWagerMessage(queues.wagerQueueUrl, JSON.parse(dead.Body!), randomUUID());
        await poll(healthy.consumer);
        expect(await txRows()).toEqual([{status: 'FAILED', failure_code: 'PROCESSING_ERROR'}]);
        expect(await balanceOf(w.walletId)).toBe('100.00');
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);

        // A resubmission with a new key is processed normally.
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));
        await poll(healthy.consumer);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('the same failure with the database also down for recordFailure: still ends in the DLQ, no row', { timeout: 60_000 }, async () => {
        const w = await openWallet(orm, '100.00');
        const down = Object.assign(Object.create(new WalletRepository()), {
            lockById: async () => { throw new Error('connection terminated'); },   // execute and recordFailure both need it
        });
        const { consumer } = await start((b) => b.overrideProvider(WalletRepository).useValue(down));
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));

        const max = messagingConfig().wagerMaxReceiveCount;
        for (let receive = 1; receive <= max; receive++) {
            await poll(consumer);
            await visibilityTimeout();
        }
        // The consumer left the message in place on its last receive; the next receive makes SQS redrive it.
        await poll(consumer);

        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        expect(await queueDepth(queues.wagerDlqUrl)).toBe(1);
        expect(await txRows()).toEqual([]);
        expect(await balanceOf(w.walletId)).toBe('100.00');
    });

    it('a failing DLQ send leaves the message in place', async () => {
        const { consumer } = await start((b) => b.overrideProvider(SQS_CLIENT).useValue(flakySqs((c) => c instanceof SendMessageCommand)));
        await sendRaw('{not json');

        await poll(consumer);

        expect(await queueDepth(queues.wagerQueueUrl)).toBe(1);
        expect(await queueDepth(queues.wagerDlqUrl)).toBe(0);
    });

    it('shutdown during processing: the message in hand commits and is deleted; the unstarted ones are visible again at once', async () => {
        const w = await openWallet(orm, '100.00');
        let reached!: () => void;
        const started = new Promise<void>((r) => (reached = r));
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const real = new InboxRepository();
        const slow = Object.assign(Object.create(real), {                       // the first message waits mid-handling
            tryInsert: async (...args: Parameters<InboxRepository['tryInsert']>) => { reached(); await gate; return real.tryInsert(...args); },
        });
        const { app, consumer } = await start((b) => b.overrideProvider(InboxRepository).useValue(slow));
        const bodies = [wagerBody(w), wagerBody(w), wagerBody(w)];
        for (const body of bodies) await sendWagerMessage(queues.wagerQueueUrl, body);

        const polling = consumer.pollOnce(1);
        await started;
        const closing = app.close();                 // SIGTERM while message 1 is mid-handling
        await sleep(300);
        release();
        await closing;
        await polling;

        expect(await txRows()).toEqual([{status: 'PROCESSED', failure_code: null}]);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        const handedBack = await receiveAll(queues.wagerQueueUrl);              // no visibility wait: released with timeout 0
        expect(handedBack.map((m) => JSON.parse(m.Body!).messageId)).toEqual([bodies[1].messageId, bodies[2].messageId]);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('with workers on, the timer loop consumes on its own and close() stops it without waiting out the long poll', async () => {
        const w = await openWallet(orm, '100.00');
        const app = await buildApp({queues, workers: true});
        await sendWagerMessage(queues.wagerQueueUrl, wagerBody(w));

        for (let i = 0; i < 50 && (await count('wager_transactions WHERE kind <> \'OPENING\'')) === 0; i++) await sleep(200);
        const closeStart = Date.now();
        await app.close();

        expect(await balanceOf(w.walletId)).toBe('90.00');
        expect(await queueDepth(queues.wagerQueueUrl)).toBe(0);
        expect(Date.now() - closeStart).toBeLessThan(5000);       // the 20 s long poll was aborted
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('WAGER_MAX_RECEIVE_COUNT equals the redrive policy of the real queue', async () => {
        const {Attributes} = await sqs.send(new GetQueueAttributesCommand({QueueUrl: process.env.WAGER_QUEUE_URL!, AttributeNames: ['RedrivePolicy']}));
        expect(Number(JSON.parse(Attributes!.RedrivePolicy!).maxReceiveCount)).toBe(messagingConfig().wagerMaxReceiveCount);
    });
});

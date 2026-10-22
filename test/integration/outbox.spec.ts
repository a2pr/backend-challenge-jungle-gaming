import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {SendMessageCommand, SQSClient} from '@aws-sdk/client-sqs';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, openWallet, runInParallel} from '../support/fixtures.js';
import {createTestQueues, receiveAll, sqs} from '../support/sqs.js';
import {SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTransaction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {OutboxPublisher} from '../../src/messaging/outboxPublisher.js';
import type {OutboxMessage} from '../../src/messaging/outboxMessage.js';
import type {MessagingConfig} from '../../src/messaging/messaging.config.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';

let orm: MikroORM;
let queues: Awaited<ReturnType<typeof createTestQueues>>;

class FailingOutbox extends OutboxRepository {
    override async enqueue(): Promise<void> { throw new Error('outbox down'); }
}
// Dies after SendMessage, before the commit: the process-crash window.
class CrashingSaveOutbox extends OutboxRepository {
    override async save(_em: never, _message: OutboxMessage): Promise<void> { throw new Error('crash before commit'); }
}

const submitWith = (outbox = new OutboxRepository()) =>
    new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), outbox, new InboxRepository());

const config = (over: Partial<MessagingConfig> = {}): MessagingConfig => ({
    ...queues, workersEnabled: false, outboxPollMs: 1000, pendingPollMs: 5000, wagerMaxReceiveCount: 5, ...over,
});
const publisher = (over: Partial<MessagingConfig> = {}, outbox = new OutboxRepository(), client: SQSClient = sqs) =>
    new OutboxPublisher(orm, outbox, client, config(over));

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const types = async () => (await receiveAll(queues.eventsQueueUrl)).map((m) => m.MessageAttributes!.eventType.StringValue).sort();
const eventIds = async () => (await receiveAll(queues.eventsQueueUrl)).map((m) => m.MessageAttributes!.eventId.StringValue);
const seed = (n: number) => rows(
    `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
     SELECT gen_random_uuid(), gen_random_uuid(), 'Seeded', '{}', now(), now() FROM generate_series(1, ?)`, [n]);
const pending = async () => Number((await rows('SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL'))[0].n);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => orm.close());
beforeEach(async () => {
    await truncateAll(orm);
    queues = await createTestQueues(); // fresh queue per test: no leftovers hidden by the visibility timeout
});

describe('OutboxPublisher', () => {
    it('a committed BET publishes its two events, a LOSS only one, and every row gets published_at', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const submit = submitWith();
        const bet = betCommand({walletId, playerId, money: brl('10.00')});
        await submit.execute(bet);

        expect(await publisher().tick()).toEqual({published: 2, failed: 0});
        expect(await types()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

        await submit.execute(betCommand({walletId, playerId, kind: WagerTransactionKind.Loss, money: brl('10.00')}));
        expect(await publisher().tick()).toEqual({published: 1, failed: 0});
        expect(await types()).toEqual(['WagerTransactionProcessed']);

        expect(await pending()).toBe(0);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('a rolled-back transaction publishes nothing', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        await expect(submitWith(new FailingOutbox()).execute(betCommand({walletId, playerId}))).rejects.toThrow('outbox down');

        expect(await publisher().tick()).toEqual({published: 0, failed: 0});
        expect(await receiveAll(queues.eventsQueueUrl)).toEqual([]);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('crash after commit, before publishing: a second publisher sends the events', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        await submitWith().execute(betCommand({walletId, playerId}));
        // the first process died here: its publisher never ticked
        expect(await receiveAll(queues.eventsQueueUrl)).toEqual([]);

        expect(await publisher().tick()).toEqual({published: 2, failed: 0});
        expect(await types()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('crash after SendMessage, before the commit: rows stay pending and are sent again (duplicate, not a loss)', async () => {
        await seed(3);
        await expect(publisher({}, new CrashingSaveOutbox()).tick()).rejects.toThrow('crash before commit');
        expect(await pending()).toBe(3);
        const first = await eventIds();
        expect(first).toHaveLength(1);   // the crash hit on the first save, so one message had left

        expect(await publisher().tick()).toEqual({published: 3, failed: 0});
        const second = await eventIds();
        expect(new Set([...first, ...second]).size).toBe(3);
        expect(await pending()).toBe(0);
    });

    it('two publishers over the same 100 rows: all published, 100 distinct eventIds, no retries', async () => {
        await seed(100);

        await runInParallel(2, () => publisher().tick());

        expect(await pending()).toBe(0);
        expect(new Set(await eventIds()).size).toBe(100);
        expect(Number((await rows('SELECT MAX(attempts)::int AS m FROM outbox_messages'))[0].m)).toBe(0);
    });

    it('a failing publish schedules a retry by the backoff, and a later due tick publishes it', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        await submitWith().execute(betCommand({walletId, playerId}));
        const t0 = new Date();

        const result = await publisher({eventsQueueUrl: `${queues.eventsQueueUrl}-missing`}).tick(t0);

        expect(result).toEqual({published: 0, failed: 2});
        const stored = await rows('SELECT attempts, published_at, next_attempt_at FROM outbox_messages');
        for (const row of stored) {
            expect(row.attempts).toBe(1);
            expect(row.published_at).toBeNull();
            expect(new Date(row.next_attempt_at).getTime()).toBe(t0.getTime() + 5000);
        }
        expect(await publisher().tick(t0)).toEqual({published: 0, failed: 0});            // not due yet
        expect(await publisher().tick(new Date(t0.getTime() + 5000))).toEqual({published: 2, failed: 0});
        expect(await pending()).toBe(0);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('one failing message in a batch of 5 does not stop the other 4', async () => {
        await seed(5);
        const [{id: badId}] = await rows('SELECT id FROM outbox_messages LIMIT 1');
        const flaky = {
            send: (cmd: unknown) => {
                if (cmd instanceof SendMessageCommand && cmd.input.MessageAttributes?.eventId?.StringValue === badId) {
                    throw new Error('boom');
                }
                return sqs.send(cmd as SendMessageCommand);
            },
        } as unknown as SQSClient;

        expect(await publisher({}, new OutboxRepository(), flaky).tick()).toEqual({published: 4, failed: 1});

        expect(await eventIds()).not.toContain(badId);
        const [bad] = await rows('SELECT attempts, published_at FROM outbox_messages WHERE id = ?', [badId]);
        expect(bad).toEqual({attempts: 1, published_at: null});
        expect(await pending()).toBe(1);
    });

    it('the timer publishes on its own and shutdown waits for the running tick', async () => {
        await seed(2);
        const timed = publisher({workersEnabled: true, outboxPollMs: 20});

        timed.onApplicationBootstrap();
        await vi.waitFor(async () => expect(await pending()).toBe(0), {timeout: 5000});
        await timed.onApplicationShutdown();

        expect(new Set(await eventIds()).size).toBe(2);
    });

    it('with the timer disabled nothing is published until tick() is called', async () => {
        await seed(2);
        const idle = publisher();

        idle.onApplicationBootstrap();
        expect(await pending()).toBe(2);
        await idle.onApplicationShutdown();
        expect(await receiveAll(queues.eventsQueueUrl)).toEqual([]);
    });
});

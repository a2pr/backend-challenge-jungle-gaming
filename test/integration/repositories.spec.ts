import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {EntityManager, MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, openWallet} from '../support/fixtures.js';
import Wallet from '../../src/wallet/wallet.js';
import WagerTransaction from '../../src/wager/wagerTransaction.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import {FailureCode} from '../../src/wager/failureCode.js';
import {WagerTransactionStatus} from '../../src/wager/wagerTransactionStatus.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTransaction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WalletBalanceChanged} from '../../src/events/walletBalanceChanged.js';
import {WalletRow} from '../../src/wallet/wallet.schema.js';
import {OutboxMessageRow} from '../../src/messaging/outboxMessage.schema.js';
import {InboxMessageRow} from '../../src/messaging/inboxMessage.schema.js';

let orm: MikroORM;
const wallets = new WalletRepository();
const wagers = new WagerTransactionRepository();
const ledger = new WalletLedgerRepository();
const outbox = new OutboxRepository();
const inbox = new InboxRepository();

const t0 = new Date('2026-01-01T00:00:00.000Z');
// Every repository call runs on a forked, transactional em, like the use cases will.
const inTx = <T>(fn: (em: EntityManager) => Promise<T>) => orm.em.fork().transactional(fn);

// A BET of `amount` against the wallet, built through the same command the use case will receive.
const newBet = (walletId: string, playerId: string, amount = '10.00', o: Partial<Parameters<typeof betCommand>[0]> = {}) => {
    const c = betCommand({walletId, playerId, money: brl(amount), ...o});
    return WagerTransaction.create({id: randomUUID(), ...c, now: t0});
};

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('WalletRepository', () => {
    it('lockById returns the wallet, or null when it does not exist', async () => {
        const {walletId} = await openWallet(orm, '100.00');

        const found = await inTx((em) => wallets.lockById(em, walletId));
        const missing = await inTx((em) => wallets.lockById(em, randomUUID()));

        expect(found?.balance.toString()).toBe('100.00');
        expect(found?.version).toBe(1);
        expect(missing).toBeNull();
    });

    it('insert writes a new wallet row', async () => {
        const wallet = Wallet.open({id: randomUUID(), playerId: randomUUID(), initialBalance: brl('0.00'), now: t0});

        await inTx((em) => wallets.insert(em, wallet));

        const row = await orm.em.fork().findOneOrFail(WalletRow, wallet.id);
        expect(row).toMatchObject({balance: '0.00', version: 1, currency: 'BRL'});
    });

    it('lockById blocks a second locker until the first transaction ends', async () => {
        const {walletId} = await openWallet(orm, '100.00');
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let aLocked!: () => void;
        const aHasLock = new Promise<void>((resolve) => (aLocked = resolve));

        const a = inTx(async (em) => {
            await wallets.lockById(em, walletId);
            order.push('A locked');
            aLocked();
            await gate;
            order.push('A done');
        });
        await aHasLock;
        const b = inTx(async (em) => {
            await wallets.lockById(em, walletId);
            order.push('B locked');
        });

        await sleep(300);
        expect(order, 'B must still be waiting for the row lock').toEqual(['A locked']);
        release();
        await Promise.all([a, b]);
        expect(order).toEqual(['A locked', 'A done', 'B locked']);
    });

    it('save persists a movement and keeps the ledger invariant', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const bet = newBet(walletId, playerId);

        await inTx(async (em) => {
            const wallet = (await wallets.lockById(em, walletId))!;
            bet.markProcessed(undefined, t0);
            await wagers.insert(em, bet, {balanceAfter: '90.00'});
            const entry = wallet.debit(bet.money, {entryId: randomUUID(), transactionId: bet.id, now: t0});
            await ledger.insert(em, entry);
            await wallets.save(em, wallet);
        });

        const row = await orm.em.fork().findOneOrFail(WalletRow, walletId);
        expect(row).toMatchObject({balance: '90.00', version: 2});
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('save with a stale version throws and changes nothing', async () => {
        const {walletId} = await openWallet(orm, '100.00');

        await expect(inTx(async (em) => {
            const wallet = (await wallets.lockById(em, walletId))!;
            // Someone bypassed the lock and moved the version under us.
            await em.getConnection().execute('UPDATE wallets SET version = 5 WHERE id = ?', [walletId], 'run', em.getTransactionContext());
            wallet.credit(brl('1.00'), {entryId: randomUUID(), transactionId: randomUUID(), now: t0});
            await wallets.save(em, wallet);
        })).rejects.toThrow('Wallet version conflict');

        const row = await orm.em.fork().findOneOrFail(WalletRow, walletId);
        expect(row).toMatchObject({balance: '100.00', version: 1});
    });
});

describe('WagerTransactionRepository', () => {
    it('insert + finders: keeps balanceAfter for replays and scopes lookups by provider', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const bet = newBet(walletId, playerId);
        bet.markProcessed(undefined, t0);

        await inTx((em) => wagers.insert(em, bet, {balanceAfter: '90.00'}));

        const byKey = await inTx((em) => wagers.findByIdempotencyKey(em, bet.providerId, bet.idempotencyKey));
        const byExternal = await inTx((em) => wagers.findByExternalId(em, bet.providerId, bet.externalTransactionId));
        expect(byKey?.balanceAfter).toBe('90.00');
        expect(byKey?.transaction.id).toBe(bet.id);
        expect(byExternal?.transaction.id).toBe(bet.id);
        expect(await inTx((em) => wagers.findByIdempotencyKey(em, 'other-provider', bet.idempotencyKey))).toBeNull();
        expect(await inTx((em) => wagers.findByExternalId(em, bet.providerId, 'nope'))).toBeNull();
    });

    it('findById returns any status with its balanceAfter, and null for an unknown id', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const rejected = newBet(walletId, playerId);
        rejected.reject(FailureCode.InsufficientFunds);
        await inTx((em) => wagers.insert(em, rejected, {balanceAfter: '100.00'}));

        const found = await inTx((em) => wagers.findById(em, rejected.id));

        expect(found?.transaction.status).toBe(WagerTransactionStatus.Rejected);
        expect(found?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(found?.balanceAfter).toBe('100.00');
        expect(await inTx((em) => wagers.findById(em, randomUUID()))).toBeNull();
    });

    it('findProcessedById ignores rows that are not PROCESSED', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const processed = newBet(walletId, playerId);
        processed.markProcessed(undefined, t0);
        const rejected = newBet(walletId, playerId);
        rejected.reject('INSUFFICIENT_FUNDS' as never);
        await inTx(async (em) => {
            await wagers.insert(em, processed, {balanceAfter: '100.00'});
            await wagers.insert(em, rejected, {balanceAfter: '100.00'});
        });

        expect((await inTx((em) => wagers.findProcessedById(em, processed.id)))?.id).toBe(processed.id);
        expect(await inTx((em) => wagers.findProcessedById(em, rejected.id))).toBeNull();
    });

    it('findReversalOf finds only a PROCESSED REFUND/ROLLBACK of that reference', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const bet = newBet(walletId, playerId);
        bet.markProcessed(undefined, t0);
        const refund = newBet(walletId, playerId, '10.00', {
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: bet.externalTransactionId,
        });
        refund.markProcessed(bet.id, t0);
        await inTx(async (em) => {
            await wagers.insert(em, bet, {balanceAfter: '90.00'});
            await wagers.insert(em, refund, {balanceAfter: '100.00'});
        });

        expect((await inTx((em) => wagers.findReversalOf(em, bet.id)))?.id).toBe(refund.id);
        expect(await inTx((em) => wagers.findReversalOf(em, randomUUID()))).toBeNull();
    });
});

describe('WalletLedgerRepository', () => {
    it('insert + sumByWallet rebuild the balance from the entries', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const bet = newBet(walletId, playerId, '30.00');
        bet.markProcessed(undefined, t0);

        const before = await inTx((em) => ledger.sumByWallet(em, walletId));
        expect(before).toEqual({ledgerBalance: '100.00', entries: 1});

        await inTx(async (em) => {
            const wallet = (await wallets.lockById(em, walletId))!;
            await wagers.insert(em, bet, {balanceAfter: '70.00'});
            await ledger.insert(em, wallet.debit(bet.money, {entryId: randomUUID(), transactionId: bet.id, now: t0}));
            await wallets.save(em, wallet);
        });

        expect(await inTx((em) => ledger.sumByWallet(em, walletId))).toEqual({ledgerBalance: '70.00', entries: 2});
        await assertLedgerMatchesBalance(orm, walletId);
    });

    async function betTwice() {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        for (const amount of ['30.00', '20.00']) {
            const bet = newBet(walletId, playerId, amount);
            bet.markProcessed(undefined, t0);
            await inTx(async (em) => {
                const wallet = (await wallets.lockById(em, walletId))!;
                await wagers.insert(em, bet, {balanceAfter: wallet.balance.subtract(bet.money).toString()});
                await ledger.insert(em, wallet.debit(bet.money, {entryId: randomUUID(), transactionId: bet.id, now: t0}));
                await wallets.save(em, wallet);
            });
        }
        return walletId;
    }

    it('page walks the entries in seq order, with afterSeq as the cursor', async () => {
        const walletId = await betTwice();   // OPENING credit, then two debits

        const all = await inTx((em) => ledger.page(em, walletId, 0, 10));
        expect(all.map((r) => [r.direction, r.amount, r.balanceBefore, r.balanceAfter])).toEqual([
            ['CREDIT', '100.00', '0.00', '100.00'], ['DEBIT', '30.00', '100.00', '70.00'], ['DEBIT', '20.00', '70.00', '50.00'],
        ]);
        expect(all[0].seq).toBeLessThan(all[1].seq);

        const first = await inTx((em) => ledger.page(em, walletId, 0, 1));
        const rest = await inTx((em) => ledger.page(em, walletId, first[0].seq, 10));
        expect(first.map((r) => r.id)).toEqual([all[0].id]);
        expect(rest.map((r) => r.id)).toEqual([all[1].id, all[2].id]);
        expect(await inTx((em) => ledger.page(em, walletId, all[2].seq, 10))).toEqual([]);
    });

    it('page never returns another wallet\'s entries', async () => {
        const walletId = await betTwice();
        const other = await openWallet(orm, '5.00');

        const rows = await inTx((em) => ledger.page(em, other.walletId, 0, 10));

        expect(rows).toHaveLength(1);
        expect(rows.every((r) => r.balanceAfter === '5.00')).toBe(true);
        expect((await inTx((em) => ledger.page(em, walletId, 0, 10))).length).toBe(3);
    });

    it('reconcile: consistent wallet has a zero difference; a corrupted balance shows a signed difference', async () => {
        const walletId = await betTwice();

        expect(await inTx((em) => ledger.reconcile(em, walletId)))
            .toEqual({currency: 'BRL', storedBalance: '50.00', ledgerBalance: '50.00', difference: '0.00', entries: 3});

        await orm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['80.00', walletId]);
        expect(await inTx((em) => ledger.reconcile(em, walletId))).toMatchObject({storedBalance: '80.00', ledgerBalance: '50.00', difference: '30.00'});

        await orm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['10.00', walletId]);
        expect((await inTx((em) => ledger.reconcile(em, walletId)))!.difference).toBe('-40.00');
    });

    it('reconcile of an unknown wallet is null', async () => {
        expect(await inTx((em) => ledger.reconcile(em, randomUUID()))).toBeNull();
    });

    it('sumByWallet of an unknown wallet is zero', async () => {
        expect(await inTx((em) => ledger.sumByWallet(em, randomUUID()))).toEqual({ledgerBalance: '0.00', entries: 0});
    });
});

describe('OutboxRepository', () => {
    it('enqueue writes due, unpublished rows carrying the envelope', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const bet = newBet(walletId, playerId);
        const wallet = (await inTx((em) => wallets.lockById(em, walletId)))!;
        const entry = wallet.debit(bet.money, {entryId: randomUUID(), transactionId: bet.id, now: t0});
        const event = WalletBalanceChanged.from(wallet, entry, {eventId: randomUUID(), correlationId: 'corr-1', occurredAt: t0});

        await inTx((em) => outbox.enqueue(em, [event]));

        const rows = await orm.em.fork().find(OutboxMessageRow, {});
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({id: event.eventId, aggregateId: walletId, eventType: 'WalletBalanceChanged', attempts: 0, publishedAt: null});
        expect(rows[0]!.nextAttemptAt).toEqual(t0);
        expect(rows[0]!.payload).toMatchObject({eventId: event.eventId, correlationId: 'corr-1', occurredAt: t0.toISOString(), version: 1});
    });

    it('enqueue of an empty list writes nothing', async () => {
        await inTx((em) => outbox.enqueue(em, []));
        expect(await orm.em.fork().count(OutboxMessageRow)).toBe(0);
    });
});

describe('InboxRepository', () => {
    const message = (messageId = 'msg-1', consumerName = 'consumer-a') =>
        ({consumerName, messageId, payloadHash: 'a'.repeat(64), receivedAt: t0});

    it('tryInsert returns true the first time and false for a duplicate', async () => {
        expect(await inTx((em) => inbox.tryInsert(em, message()))).toBe(true);
        expect(await inTx((em) => inbox.tryInsert(em, message()))).toBe(false);
        expect(await orm.em.fork().count(InboxMessageRow)).toBe(1);
    });

    it('the same message id is new for a different consumer', async () => {
        await inTx((em) => inbox.tryInsert(em, message('msg-1', 'consumer-a')));
        expect(await inTx((em) => inbox.tryInsert(em, message('msg-1', 'consumer-b')))).toBe(true);
    });

    it('a rolled-back transaction leaves no inbox row', async () => {
        await expect(inTx(async (em) => {
            await inbox.tryInsert(em, message());
            throw new Error('boom');
        })).rejects.toThrow('boom');

        expect(await inTx((em) => inbox.tryInsert(em, message()))).toBe(true);
    });

    it('markProcessed sets processed_at', async () => {
        await inTx(async (em) => {
            await inbox.tryInsert(em, message());
            await inbox.markProcessed(em, 'consumer-a', 'msg-1', t0);
        });

        const row = await orm.em.fork().findOneOrFail(InboxMessageRow, {consumerName: 'consumer-a', messageId: 'msg-1'});
        expect(row.processedAt).toEqual(t0);
    });
});

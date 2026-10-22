import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, completed, openWallet, runInParallel} from '../support/fixtures.js';
import {SubmitWagerCommand, SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTransaction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WagerTransactionKind as Kind} from '../../src/wager/wagerTransactionKind.js';

let orm: MikroORM;
let useCase: SubmitWagerTransactionUseCase;
const repo = new WagerTransactionRepository();

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const stored = async (id: string) => (await rows(
    `SELECT status, failure_code, attempts, next_attempt_at, balance_after::text AS balance_after FROM wager_transactions WHERE id = ?`, [id]))[0];
const eventTypes = async (transactionId: string) =>
    (await rows(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [transactionId]))
        .map((e: any) => e.event_type).sort();
const ms = (d: Date) => new Date(d).getTime();

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    useCase = new SubmitWagerTransactionUseCase(orm, new WalletRepository(), repo,
        new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

type Wallet = { walletId: string; playerId: string };
// A REFUND of 10.00 whose BET has not arrived yet: stored as PENDING_REFERENCE.
async function pendingRefund(w: Wallet, betExternalId = `bet-${randomUUID()}`) {
    const result = completed(await useCase.execute(betCommand({
        ...w, kind: Kind.Refund, money: brl('10.00'), referenceExternalTransactionId: betExternalId,
    })));
    expect(result.status).toBe('PENDING_REFERENCE');
    return {id: result.transactionId, betExternalId};
}
const placeBet = (w: Wallet, externalTransactionId: string, amount = '10.00') =>
    useCase.execute(betCommand({...w, externalTransactionId, money: brl(amount)}));

describe('recordFailure (D8)', () => {
    it('creates one FAILED row with PROCESSING_ERROR: no ledger row, no event, balance unchanged', async () => {
        const w = await openWallet(orm, '100.00');
        const [ledger, outbox] = [await count('wallet_ledger_entries'), await count('outbox_messages')];
        const command = betCommand(w);

        await useCase.recordFailure(command);

        const [row] = await rows(`SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?`, [command.idempotencyKey]);
        expect(row).toMatchObject({status: 'FAILED', failure_code: 'PROCESSING_ERROR'});
        expect(await count('wallet_ledger_entries')).toBe(ledger);
        expect(await count('outbox_messages')).toBe(outbox);
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('twice leaves one row', async () => {
        const w = await openWallet(orm, '100.00');
        const command = betCommand(w);
        await useCase.recordFailure(command);
        await useCase.recordFailure(command);
        expect(await count(`wager_transactions WHERE idempotency_key = '${command.idempotencyKey}'`)).toBe(1);
    });

    it('for a key that already PROCESSED changes nothing', async () => {
        const w = await openWallet(orm, '100.00');
        const command = betCommand(w);
        const done = completed(await useCase.execute(command));

        await useCase.recordFailure(command);

        expect((await stored(done.transactionId)).status).toBe('PROCESSED');
        expect(await count(`wager_transactions WHERE idempotency_key = '${command.idempotencyKey}'`)).toBe(1);
        expect(await balanceOf(w.walletId)).toBe('90.00');
    });

    it('for an unknown wallet creates nothing', async () => {
        const before = await count('wager_transactions');
        await useCase.recordFailure(betCommand({walletId: randomUUID(), playerId: randomUUID()}));
        expect(await count('wager_transactions')).toBe(before);
    });
});

describe('reprocess (D3, D18)', () => {
    it('reference arrived: PROCESSED, ledger and balance applied, events queued', async () => {
        const w = await openWallet(orm, '100.00');
        const {id, betExternalId} = await pendingRefund(w);
        await placeBet(w, betExternalId);
        expect(await balanceOf(w.walletId)).toBe('90.00');

        await useCase.reprocess(id);

        expect(await balanceOf(w.walletId)).toBe('100.00');
        expect(await stored(id)).toMatchObject({status: 'PROCESSED', balance_after: '100.00', next_attempt_at: null});
        expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('reference arrived but a rule fails: REJECTED with the code', async () => {
        const w = await openWallet(orm, '100.00');
        const {id, betExternalId} = await pendingRefund(w);       // refund of 10.00
        await placeBet(w, betExternalId, '30.00');                 // the bet was 30.00

        await useCase.reprocess(id);

        expect(await stored(id)).toMatchObject({status: 'REJECTED', failure_code: 'REVERSAL_AMOUNT_MISMATCH'});
        expect(await balanceOf(w.walletId)).toBe('70.00');
        expect(await eventTypes(id)).toContain('WagerTransactionRejected');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('reference still missing: stays pending on the D3 timeline (+40 s, then +80 s) with no new event', async () => {
        const w = await openWallet(orm, '100.00');
        const {id} = await pendingRefund(w);
        const t1 = new Date('2030-01-01T00:00:00Z');
        const t2 = new Date('2030-01-01T01:00:00Z');

        await useCase.reprocess(id, t1);
        const first = await stored(id);
        expect(first).toMatchObject({status: 'PENDING_REFERENCE', attempts: 1});
        expect(ms(first.next_attempt_at)).toBe(ms(t1) + 40_000);

        await useCase.reprocess(id, t2);
        const second = await stored(id);
        expect(second).toMatchObject({status: 'PENDING_REFERENCE', attempts: 2});
        expect(ms(second.next_attempt_at)).toBe(ms(t2) + 80_000);

        expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference']);
    });

    it('reference never arrives: REJECTED REFERENCE_NOT_FOUND after the limit, event queued in the same transaction', async () => {
        const w = await openWallet(orm, '100.00');
        const {id} = await pendingRefund(w);
        const t = new Date('2030-01-01T00:00:00Z');

        await useCase.reprocess(id, t);
        await useCase.reprocess(id, t);
        await useCase.reprocess(id, t);

        expect(await stored(id)).toMatchObject({status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', next_attempt_at: null});
        expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
        expect(await balanceOf(w.walletId)).toBe('100.00');
    });

    it('a terminal or unknown id is a no-op; two concurrent calls credit once', async () => {
        const w = await openWallet(orm, '100.00');
        const {id, betExternalId} = await pendingRefund(w);
        await placeBet(w, betExternalId);

        await runInParallel(2, () => useCase.reprocess(id));
        await useCase.reprocess(id);
        await useCase.reprocess(randomUUID());

        expect(await balanceOf(w.walletId)).toBe('100.00');
        expect(await eventTypes(id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });
});

describe('findDuePendingReference', () => {
    const claim = (now: Date, limit: number, hold?: Promise<void>) => orm.em.fork().transactional(async (em) => {
        const ids = await repo.findDuePendingReference(em, now, limit);
        if (hold) await hold;
        return ids;
    });

    it('returns only due PENDING_REFERENCE ids, oldest first, and honours the limit', async () => {
        const w = await openWallet(orm, '100.00');
        const a = await pendingRefund(w);
        const b = await pendingRefund(w);
        const future = new Date(Date.now() + 3_600_000);

        const due = await claim(future, 10);
        expect([...due].sort()).toEqual([a.id, b.id].sort());
        expect(await claim(new Date(Date.now() - 3_600_000), 10)).toEqual([]);
        expect(await claim(future, 1)).toHaveLength(1);
    });

    it('two concurrent claimers get disjoint sets', async () => {
        const w = await openWallet(orm, '100.00');
        for (let i = 0; i < 4; i++) await pendingRefund(w);
        const future = new Date(Date.now() + 3_600_000);

        let release!: () => void;
        const hold = new Promise<void>((r) => (release = r));
        const first = claim(future, 2, hold);                         // keeps its locks until released
        await new Promise((r) => setTimeout(r, 200));
        const second = await claim(future, 4);                        // SKIP LOCKED passes the first claimer's rows
        release();
        const firstIds = await first;

        expect(firstIds).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(new Set([...firstIds, ...second]).size).toBe(4);
    });
});

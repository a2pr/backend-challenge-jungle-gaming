import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
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
import {PendingReferenceWorker} from '../../src/messaging/pendingReferenceWorker.js';
import {WagerTransactionKind as Kind} from '../../src/wager/wagerTransactionKind.js';

let orm: MikroORM;
let useCase: SubmitWagerTransactionUseCase;
let worker: PendingReferenceWorker;

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const stored = async (id: string) => (await rows(`SELECT status, failure_code, attempts, next_attempt_at FROM wager_transactions WHERE id = ?`, [id]))[0];
const eventTypes = async (id: string) =>
    (await rows(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [id])).map((e: any) => e.event_type).sort();
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
const ms = (d: Date) => new Date(d).getTime();

const config = {workersEnabled: false, pendingPollMs: 5000} as never;
const build = (uc: Pick<SubmitWagerTransactionUseCase, 'reprocess'>) =>
    new PendingReferenceWorker(orm, new WagerTransactionRepository(), uc as SubmitWagerTransactionUseCase, config);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    useCase = new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
    worker = build(useCase);
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

type Wallet = { walletId: string; playerId: string };
const submit = async (w: Wallet, o: Partial<SubmitWagerCommand>) => completed(await useCase.execute(betCommand({...w, ...o})));
// The reversal of a not-yet-seen transaction: 10.00 in round-1, pointing at `ref`.
const earlyReversal = (w: Wallet, kind: Kind, ref: string, amount = '10.00') =>
    submit(w, {kind, money: brl(amount), referenceExternalTransactionId: ref});
// Far enough ahead that every row stored with the real clock is due.
const later = () => new Date(Date.now() + 3_600_000);

describe('PendingReferenceWorker', () => {
    it('REFUND before its BET: stored pending, event queued; once the BET arrives a tick processes it', async () => {
        const w = await openWallet(orm, '100.00');
        const refund = await earlyReversal(w, Kind.Refund, 'bet-1');
        expect(refund.status).toBe('PENDING_REFERENCE');
        expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference']);

        await submit(w, {externalTransactionId: 'bet-1'});
        expect(await balanceOf(w.walletId)).toBe('90.00');
        expect(await worker.tick(later())).toEqual({reprocessed: 1, failed: 0});

        expect((await stored(refund.transactionId)).status).toBe('PROCESSED');
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('ROLLBACK before its WIN: processed once the WIN arrives', async () => {
        const w = await openWallet(orm, '100.00');
        const rollback = await earlyReversal(w, Kind.Rollback, 'win-1', '50.00');
        expect(rollback.status).toBe('PENDING_REFERENCE');

        await submit(w, {externalTransactionId: 'win-1', kind: Kind.Win, money: brl('50.00')});
        expect(await balanceOf(w.walletId)).toBe('150.00');
        await worker.tick(later());

        expect((await stored(rollback.transactionId)).status).toBe('PROCESSED');
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('the reference never arrives: D3 timeline (+20 s, +40 s, +80 s), then REJECTED REFERENCE_NOT_FOUND with the event in the outbox', async () => {
        const w = await openWallet(orm, '100.00');
        const refund = await earlyReversal(w, Kind.Refund, 'never');
        const t = later();

        expect(await worker.tick(t)).toEqual({reprocessed: 1, failed: 0});                       // first retry: next at +40 s
        expect(ms((await stored(refund.transactionId)).next_attempt_at)).toBe(ms(at(t, 40)));

        expect(await worker.tick(at(t, 39))).toEqual({reprocessed: 0, failed: 0});               // not due: untouched
        expect((await stored(refund.transactionId)).attempts).toBe(1);

        await worker.tick(at(t, 40));                                                            // second retry: next at +80 s
        const second = await stored(refund.transactionId);
        expect(second.attempts).toBe(2);
        expect(ms(second.next_attempt_at)).toBe(ms(at(t, 120)));

        await worker.tick(at(t, 120));                                                           // limit reached
        expect(await stored(refund.transactionId)).toMatchObject({status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', next_attempt_at: null});
        expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
        expect(await worker.tick(at(t, 1000))).toEqual({reprocessed: 0, failed: 0});
        expect(await balanceOf(w.walletId)).toBe('100.00');
    });

    it('two ticks at once over the same pending row: one effect, one credit', async () => {
        const w = await openWallet(orm, '100.00');
        const refund = await earlyReversal(w, Kind.Refund, 'bet-2');
        await submit(w, {externalTransactionId: 'bet-2'});

        await runInParallel(2, () => worker.tick(later()));

        expect(await balanceOf(w.walletId)).toBe('100.00');
        expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('one failing row does not stop the others', async () => {
        const w = await openWallet(orm, '100.00');
        const bad = await earlyReversal(w, Kind.Refund, 'bet-bad');
        const good = await earlyReversal(w, Kind.Refund, 'bet-good');
        await submit(w, {externalTransactionId: 'bet-bad'});
        await submit(w, {externalTransactionId: 'bet-good'});
        const flaky = build({reprocess: (id, now) => id === bad.transactionId ? Promise.reject(new Error('boom')) : useCase.reprocess(id, now)});

        expect(await flaky.tick(later())).toEqual({reprocessed: 1, failed: 1});

        expect((await stored(good.transactionId)).status).toBe('PROCESSED');
        expect((await stored(bad.transactionId)).status).toBe('PENDING_REFERENCE');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });
});

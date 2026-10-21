import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, completed, openWallet, runInParallel} from '../support/fixtures.js';
import {SubmitWagerCommand, SubmitWagerTransactionUseCase, WagerResult} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTrasanction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WagerTransactionKind as Kind} from '../../src/wager/wagerTransactionKind.js';

let orm: MikroORM;
// These specs never pass an inbox, so every call completes; narrow once here.
let submit: { execute(command: SubmitWagerCommand): Promise<WagerResult> };

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const eventTypes = async (transactionId: string) =>
    (await rows(`SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [transactionId]))
        .map((e: any) => e.event_type).sort();

type Wallet = { walletId: string; playerId: string };
const send = (w: Wallet, o: Partial<SubmitWagerCommand>) => submit.execute(betCommand({...w, ...o}));
// A reversal (or WIN/LOSS) of `original`: same round and amount, pointing at its external id.
const reverse = (w: Wallet, kind: Kind, original: SubmitWagerCommand, o: Partial<SubmitWagerCommand> = {}) =>
    send(w, {kind, money: original.money, roundId: original.roundId, referenceExternalTransactionId: original.externalTransactionId, ...o});
const placed = async (w: Wallet, kind: Kind, amount: string) => {
    const command = betCommand({...w, kind, money: brl(amount)});
    return {command, result: await submit.execute(command)};
};

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    const useCase = new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
    submit = {execute: async (command) => completed(await useCase.execute(command))};
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('SubmitWagerTransaction: references and reversals', () => {
    it('6. REFUND and ROLLBACK of a BET credit it back; ROLLBACK of a WIN or a REFUND debits', async () => {
        const w = await openWallet(orm, '100.00');
        const bet = await placed(w, Kind.Bet, '30.00');
        expect(await balanceOf(w.walletId)).toBe('70.00');

        const refund = await reverse(w, Kind.Refund, bet.command);
        expect(refund).toMatchObject({status: 'PROCESSED', balance: {amount: '100.00'}});
        const [link] = await rows('SELECT reference_transaction_id AS r FROM wager_transactions WHERE id = ?', [refund.transactionId]);
        expect(link.r).toBe(bet.result.transactionId);

        const undoRefund = await reverse(w, Kind.Rollback, {...bet.command, externalTransactionId: (await lastExternalId(refund.transactionId))});
        expect(undoRefund).toMatchObject({status: 'PROCESSED', balance: {amount: '70.00'}});

        const win = await placed(w, Kind.Win, '50.00');
        expect(win.result.balance.amount).toBe('120.00');
        expect(await reverse(w, Kind.Rollback, win.command)).toMatchObject({status: 'PROCESSED', balance: {amount: '70.00'}});
        await assertLedgerMatchesBalance(orm, w.walletId);

        const w2 = await openWallet(orm, '100.00');
        const bet2 = await placed(w2, Kind.Bet, '30.00');
        expect(await reverse(w2, Kind.Rollback, bet2.command)).toMatchObject({status: 'PROCESSED', balance: {amount: '100.00'}});
        await assertLedgerMatchesBalance(orm, w2.walletId);
    });

    it('6b. a WIN that references its BET is processed and linked', async () => {
        const w = await openWallet(orm, '100.00');
        const bet = await placed(w, Kind.Bet, '10.00');

        const win = await reverse(w, Kind.Win, bet.command, {money: brl('25.00')});

        expect(win).toMatchObject({status: 'PROCESSED', balance: {amount: '115.00'}});
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    describe('7. reference rules: each wrong reference is REJECTED, persisted and moves nothing', () => {
        const cases: [string, (w: Wallet, bet: SubmitWagerCommand) => Promise<{ status: string; failureCode?: string; transactionId: string; balance: { amount: string } }>, string][] = [
            ['another wallet', async (_w, bet) => { const other = await openWallet(orm, '100.00'); return reverse(other, Kind.Refund, bet); }, 'REFERENCE_MISMATCH'],
            ['another round', (w, bet) => reverse(w, Kind.Refund, bet, {roundId: 'round-other'}), 'REFERENCE_MISMATCH'],
            ['a kind that cannot be reversed this way', async (w) => reverse(w, Kind.Refund, (await placed(w, Kind.Win, '10.00')).command), 'INVALID_REFERENCE_KIND'],
            ['another amount', (w, bet) => reverse(w, Kind.Refund, bet, {money: brl('5.00')}), 'REVERSAL_AMOUNT_MISMATCH'],
        ];

        it.each(cases)('%s', async (_name, act, code) => {
            const w = await openWallet(orm, '100.00');
            const bet = await placed(w, Kind.Bet, '10.00');

            const r = await act(w, bet.command);

            expect(r).toMatchObject({status: 'REJECTED', failureCode: code});
            const [row] = await rows('SELECT status, failure_code, wallet_id FROM wager_transactions WHERE id = ?', [r.transactionId]);
            expect(row).toMatchObject({status: 'REJECTED', failure_code: code});
            // the rejection wrote no ledger row and reports the balance the wallet still has
            expect(await count(`wallet_ledger_entries WHERE transaction_id = '${r.transactionId}'`)).toBe(0);
            expect(await balanceOf(row.wallet_id)).toBe(r.balance.amount);
            await assertLedgerMatchesBalance(orm, row.wallet_id);
            await assertLedgerMatchesBalance(orm, w.walletId);
        });

        it('another provider cannot see the reference: it waits as PENDING_REFERENCE', async () => {
            const w = await openWallet(orm, '100.00');
            const bet = await placed(w, Kind.Bet, '10.00');
            const r = await reverse(w, Kind.Refund, bet.command, {providerId: 'prov-2'});
            expect(r.status).toBe('PENDING_REFERENCE');
            expect(await balanceOf(w.walletId)).toBe('90.00');
        });
    });

    it('7b. REFUND of a REJECTED BET is REFERENCE_NOT_PROCESSED', async () => {
        const w = await openWallet(orm, '10.00');
        const bet = await placed(w, Kind.Bet, '50.00');
        expect(bet.result.status).toBe('REJECTED');

        const r = await reverse(w, Kind.Refund, bet.command);

        expect(r).toMatchObject({status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED', balance: {amount: '10.00'}});
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('7b. an unknown reference, and a reversal of a PENDING_REFERENCE transaction, both become PENDING_REFERENCE', async () => {
        const w = await openWallet(orm, '100.00');

        const unknown = await send(w, {kind: Kind.Refund, referenceExternalTransactionId: 'ext-not-here'});
        expect(unknown).toMatchObject({status: 'PENDING_REFERENCE', balance: {amount: '100.00'}});
        expect(await eventTypes(unknown.transactionId)).toEqual(['WagerTransactionPendingReference']);
        const [row] = await rows('SELECT attempts, next_attempt_at FROM wager_transactions WHERE id = ?', [unknown.transactionId]);
        expect(row.attempts).toBe(0);
        expect(row.next_attempt_at).not.toBeNull();

        const pendingCmd = await lastCommand(unknown.transactionId);
        const chained = await reverse(w, Kind.Rollback, pendingCmd);
        expect(chained.status).toBe('PENDING_REFERENCE');
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('7c. a REFUND is replayed with its stored PENDING_REFERENCE state', async () => {
        const w = await openWallet(orm, '100.00');
        const cmd = betCommand({...w, kind: Kind.Refund, referenceExternalTransactionId: 'ext-later'});
        const first = await submit.execute(cmd);
        const replay = await submit.execute(cmd);
        expect(replay).toEqual({...first, idempotentReplay: true});
    });

    it('8. two REFUNDs of the same BET in parallel: one PROCESSED, one ALREADY_REVERSED, credited once', async () => {
        const w = await openWallet(orm, '100.00');
        const bet = await placed(w, Kind.Bet, '30.00');

        const results = await runInParallel(2, () => reverse(w, Kind.Refund, bet.command));

        expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('ALREADY_REVERSED');
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('8b. a ROLLBACK racing a REFUND of the same BET: same outcome (D5)', async () => {
        const w = await openWallet(orm, '100.00');
        const bet = await placed(w, Kind.Bet, '30.00');

        const results = await Promise.all([reverse(w, Kind.Refund, bet.command), reverse(w, Kind.Rollback, bet.command)]);

        expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('ALREADY_REVERSED');
        expect(await balanceOf(w.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('9. ROLLBACK of a WIN after the winnings were spent is INSUFFICIENT_FUNDS_FOR_REVERSAL, persisted, balance unchanged', async () => {
        const w = await openWallet(orm, '100.00');
        const win = await placed(w, Kind.Win, '50.00');
        await placed(w, Kind.Bet, '140.00');
        expect(await balanceOf(w.walletId)).toBe('10.00');

        const r = await reverse(w, Kind.Rollback, win.command);

        expect(r).toMatchObject({status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL', balance: {amount: '10.00'}});
        const [row] = await rows('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [r.transactionId]);
        expect(row).toEqual({status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS_FOR_REVERSAL'});
        expect(await balanceOf(w.walletId)).toBe('10.00');
        await assertLedgerMatchesBalance(orm, w.walletId);
    });
});

// Rebuilds the command fields a later reference needs from the stored row.
async function lastCommand(transactionId: string): Promise<SubmitWagerCommand> {
    const [r] = await rows(
        `SELECT provider_id, external_transaction_id, id_key, wallet_id, player_id, round_id, game_id, kind, amount::text AS amount, currency
         FROM wager_transactions WHERE id = ?`.replace('id_key', 'idempotency_key'), [transactionId]);
    return betCommand({
        walletId: r.wallet_id, playerId: r.player_id, providerId: r.provider_id, externalTransactionId: r.external_transaction_id,
        roundId: r.round_id, gameId: r.game_id, kind: r.kind, money: brl(r.amount),
    });
}
const lastExternalId = async (transactionId: string) =>
    (await rows('SELECT external_transaction_id AS e FROM wager_transactions WHERE id = ?', [transactionId]))[0].e as string;

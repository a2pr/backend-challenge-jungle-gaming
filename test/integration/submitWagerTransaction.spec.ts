import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, openWallet, runInParallel} from '../support/fixtures.js';
import {SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTrasanction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import {
    DuplicateExternalTransactionError, IdempotencyConflictError, InvalidWagerTransactionError, WalletNotFoundError,
} from '../../src/wager/errors.js';
import Money from '../../src/money/money.js';

let orm: MikroORM;
let submit: SubmitWagerTransactionUseCase;

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const debits = async (walletId: string) =>
    Number((await rows(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0].n);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    submit = new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('SubmitWagerTransaction: simple kinds', () => {
    it('1. two concurrent BETs of 80.00 on 100.00: one debit, one INSUFFICIENT_FUNDS', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');

        const results = await runInParallel(2, () => submit.execute(betCommand({walletId, playerId, money: brl('80.00')})));

        expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
        expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
        expect(await balanceOf(walletId)).toBe('20.00');
        expect(await debits(walletId)).toBe(1);
        const events = await rows(`SELECT event_type FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'`);
        expect(events).toHaveLength(1);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('6. BET debits, WIN credits, LOSS leaves the balance and writes no ledger row', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');

        const bet = await submit.execute(betCommand({walletId, playerId, money: brl('30.00')}));
        expect(bet).toMatchObject({status: 'PROCESSED', balance: {amount: '70.00', currency: 'BRL'}, idempotentReplay: false});
        const win = await submit.execute(betCommand({walletId, playerId, kind: WagerTransactionKind.Win, money: brl('50.00')}));
        expect(win).toMatchObject({status: 'PROCESSED', balance: {amount: '120.00', currency: 'BRL'}});

        const ledgerBefore = await count('wallet_ledger_entries');
        const loss = await submit.execute(betCommand({walletId, playerId, kind: WagerTransactionKind.Loss, money: brl('10.00')}));
        expect(loss).toMatchObject({status: 'PROCESSED', balance: {amount: '120.00', currency: 'BRL'}});
        expect(await count('wallet_ledger_entries')).toBe(ledgerBefore);
        const lossEvents = await rows(
            `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`, [loss.transactionId]);
        expect(lossEvents.map((e: any) => e.event_type)).toEqual(['WagerTransactionProcessed']);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('9b. another player or another currency is rejected, persisted, and moves nothing', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const ledgerBefore = await count('wallet_ledger_entries');

        const wrongPlayer = await submit.execute(betCommand({walletId, playerId: randomUUID()}));
        const wrongCurrency = await submit.execute(betCommand({walletId, playerId, money: Money.from({amount: '10.00', currency: 'USD'})}));

        expect(wrongPlayer).toMatchObject({status: 'REJECTED', failureCode: 'PLAYER_MISMATCH', balance: {amount: '100.00'}});
        expect(wrongCurrency).toMatchObject({status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: {amount: '100.00'}});
        for (const r of [wrongPlayer, wrongCurrency]) {
            const [row] = await rows('SELECT status, failure_code FROM wager_transactions WHERE id = ?', [r.transactionId]);
            expect(row).toEqual({status: 'REJECTED', failure_code: r.failureCode});
        }
        expect(await balanceOf(walletId)).toBe('100.00');
        expect(await count('wallet_ledger_entries')).toBe(ledgerBefore);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('an unknown wallet throws WalletNotFoundError and writes nothing', async () => {
        await expect(submit.execute(betCommand({walletId: randomUUID(), playerId: randomUUID()}))).rejects.toBeInstanceOf(WalletNotFoundError);
        expect([await count('wager_transactions'), await count('outbox_messages')]).toEqual([0, 0]);
    });

    it('a blank roundId throws InvalidWagerTransactionError and writes nothing', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const before = await count('wager_transactions');

        await expect(submit.execute(betCommand({walletId, playerId, roundId: ' '}))).rejects.toBeInstanceOf(InvalidWagerTransactionError);

        expect(await count('wager_transactions')).toBe(before);
        expect(await balanceOf(walletId)).toBe('100.00');
    });
});

describe('SubmitWagerTransaction: idempotency', () => {
    const txRows = (walletId: string) => count(`wager_transactions WHERE wallet_id = '${walletId}' AND kind = 'BET'`);

    it('2. the same BET sent 50 times in parallel debits once: 1 original, 49 replays', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('10.00')});

        const results = await runInParallel(50, () => submit.execute(cmd));

        expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
        expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
        expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
        expect(await txRows(walletId)).toBe(1);
        expect(await debits(walletId)).toBe(1);
        expect(await balanceOf(walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('3. a replay returns the original balance, not the current one, and writes nothing', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('10.00')});
        const first = await submit.execute(cmd);
        await submit.execute(betCommand({walletId, playerId, money: brl('30.00')}));
        const outboxBefore = await count('outbox_messages');

        const replay = await submit.execute(cmd);

        expect(replay).toEqual({...first, idempotentReplay: true});
        expect(replay.balance.amount).toBe('90.00');
        expect(await balanceOf(walletId)).toBe('60.00');
        expect(await count('outbox_messages')).toBe(outboxBefore);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('3b. a replay of a rejected transaction returns the same rejection', async () => {
        const {walletId, playerId} = await openWallet(orm, '10.00');
        const cmd = betCommand({walletId, playerId, money: brl('50.00')});
        const first = await submit.execute(cmd);

        const replay = await submit.execute(cmd);

        expect(first).toMatchObject({status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS'});
        expect(replay).toEqual({...first, idempotentReplay: true});
        expect(await txRows(walletId)).toBe(1);
    });

    it('4. the same key with another amount or another wallet throws IdempotencyConflictError and moves nothing', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const other = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('10.00')});
        await submit.execute(cmd);
        const rowsBefore = await count('wager_transactions');

        await expect(submit.execute({...cmd, money: brl('20.00')})).rejects.toBeInstanceOf(IdempotencyConflictError);
        await expect(submit.execute({...cmd, walletId: other.walletId, playerId: other.playerId}))
            .rejects.toBeInstanceOf(IdempotencyConflictError);

        expect(await count('wager_transactions')).toBe(rowsBefore);
        expect(await balanceOf(walletId)).toBe('90.00');
        expect(await balanceOf(other.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, walletId);
        await assertLedgerMatchesBalance(orm, other.walletId);
    });

    it('5. the same externalTransactionId under another key throws DuplicateExternalTransactionError', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const first = betCommand({walletId, playerId});
        await submit.execute(first);
        const rowsBefore = await count('wager_transactions');

        await expect(submit.execute(betCommand({walletId, playerId, externalTransactionId: first.externalTransactionId})))
            .rejects.toBeInstanceOf(DuplicateExternalTransactionError);

        expect(await count('wager_transactions')).toBe(rowsBefore);
        expect(await balanceOf(walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, walletId);
    });
});

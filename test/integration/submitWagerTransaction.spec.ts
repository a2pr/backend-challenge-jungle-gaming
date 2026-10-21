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
import {WalletNotFoundError} from '../../src/wager/errors.js';
import {InvalidWagerTransactionError} from '../../src/wager/errors.js';
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

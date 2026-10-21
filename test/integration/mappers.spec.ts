import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import Money from '../../src/money/money.js';
import Wallet from '../../src/wallet/wallet.js';
import WalletLedgerEntry, {LedgerDirection} from '../../src/wallet/walletLedgerEntry.js';
import WagerTransaction from '../../src/wager/wagerTransaction.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import {WagerTransactionStatus} from '../../src/wager/wagerTransactionStatus.js';
import {FailureCode} from '../../src/wager/failureCode.js';
import {WalletRow} from '../../src/wallet/wallet.schema.js';
import {WagerTransactionRow} from '../../src/wager/wagerTransaction.schema.js';
import {WalletLedgerEntryRow} from '../../src/wallet/walletLedgerEntry.schema.js';
import * as walletMapper from '../../src/wallet/wallet.mapper.js';
import * as txMapper from '../../src/wager/wagerTransaction.mapper.js';
import * as ledgerMapper from '../../src/wallet/walletLedgerEntry.mapper.js';

let orm: MikroORM;

const W = '00000000-0000-0000-0000-000000000001';
const P = '10000000-0000-0000-0000-000000000001';
const T = '20000000-0000-0000-0000-000000000001';
const L = '30000000-0000-0000-0000-000000000001';
const brl = (amount: string) => Money.from({amount, currency: 'BRL'});
const t0 = new Date('2026-01-01T00:00:00.000Z');

const newWallet = () => Wallet.open({id: W, playerId: P, initialBalance: brl('0.10'), now: t0});
const newTx = (o: {id?: string; ext?: string} = {}) =>
    WagerTransaction.create({
        id: o.id ?? T, providerId: 'prov', externalTransactionId: o.ext ?? 'ext-1', idempotencyKey: `key-${o.ext ?? 'ext-1'}`,
        walletId: W, playerId: P, roundId: 'r1', gameId: 'g1', kind: WagerTransactionKind.Bet, money: brl('0.10'), now: t0,
    });

// Each step uses a fresh fork so reads hit the database, not the identity map.
async function save(row: object) {
    const em = orm.em.fork();
    em.persist(row);
    await em.flush();
}

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('wallet', () => {
    it('round-trips and keeps 0.10 as a string, not a number', async () => {
        const wallet = newWallet();
        await save(walletMapper.toRow(wallet));

        const row = await orm.em.fork().findOneOrFail(WalletRow, W);
        expect(row.balance).toBe('0.10');
        const back = walletMapper.toDomain(row);
        expect(back.balance.equals(wallet.balance)).toBe(true);
        expect(back).toMatchObject({id: W, playerId: P, currency: 'BRL', version: 1});
        expect(back.createdAt).toEqual(t0);
    });
});

describe('wager transaction', () => {
    beforeEach(() => save(walletMapper.toRow(newWallet())));

    it('round-trips a new transaction; optionals come back undefined', async () => {
        const tx = newTx();
        await save(txMapper.toRow(tx));

        const row = await orm.em.fork().findOneOrFail(WagerTransactionRow, T);
        expect(row).toMatchObject({amount: '0.10', currency: 'BRL', balanceAfter: null, failureCode: null});
        const back = txMapper.toDomain(row);
        expect(back.money.equals(tx.money)).toBe(true);
        expect(back).toMatchObject({
            status: WagerTransactionStatus.Pending, kind: WagerTransactionKind.Bet, payloadHash: tx.payloadHash, attempts: 0,
            referenceExternalTransactionId: undefined, referenceTransactionId: undefined,
            failureCode: undefined, processedAt: undefined, nextAttemptAt: undefined,
        });
    });

    it('writes balanceAfter only when extras carry it', async () => {
        const tx = newTx();
        await save(txMapper.toRow(tx, {balanceAfter: '0.00'}));
        expect((await orm.em.fork().findOneOrFail(WagerTransactionRow, T)).balanceAfter).toBe('0.00');
    });

    it('persists a rejection with its failure code', async () => {
        const tx = newTx();
        tx.reject(FailureCode.InsufficientFunds);
        await save(txMapper.toRow(tx));

        const back = txMapper.toDomain(await orm.em.fork().findOneOrFail(WagerTransactionRow, T));
        expect(back).toMatchObject({status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds});
    });

    it('clears nextAttemptAt on update after it was set', async () => {
        const tx = newTx();
        tx.markPendingReference(t0);
        await save(txMapper.toRow(tx));
        expect((await orm.em.fork().findOneOrFail(WagerTransactionRow, T)).nextAttemptAt).toBeInstanceOf(Date);

        tx.markProcessed(undefined, new Date(t0.getTime() + 1000));
        const em = orm.em.fork();
        em.assign(await em.findOneOrFail(WagerTransactionRow, T), txMapper.toRow(tx));
        await em.flush();

        const row = await orm.em.fork().findOneOrFail(WagerTransactionRow, T);
        expect(row.nextAttemptAt).toBeNull();
        expect(txMapper.toDomain(row)).toMatchObject({status: WagerTransactionStatus.Processed, nextAttemptAt: undefined});
    });
});

describe('wallet ledger entry', () => {
    beforeEach(async () => {
        await save(walletMapper.toRow(newWallet()));
        await save(txMapper.toRow(newTx()));
    });

    it('round-trips with exact money strings', async () => {
        const entry = WalletLedgerEntry.create({
            id: L, walletId: W, transactionId: T, direction: LedgerDirection.Debit,
            money: brl('0.10'), balanceBefore: brl('0.10'), balanceAfter: brl('0.00'), now: t0,
        });
        await save(ledgerMapper.toRow(entry));

        const row = await orm.em.fork().findOneOrFail(WalletLedgerEntryRow, L);
        expect(row).toMatchObject({amount: '0.10', balanceBefore: '0.10', balanceAfter: '0.00', direction: 'DEBIT'});
        const back = ledgerMapper.toDomain(row);
        expect(back.isBalanced()).toBe(true);
        expect(back.money.equals(entry.money)).toBe(true);
        expect(back.createdAt).toEqual(t0);
    });
});

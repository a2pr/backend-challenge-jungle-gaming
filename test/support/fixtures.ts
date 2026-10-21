import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import Money from '../../src/money/money.js';
import Wallet from '../../src/wallet/wallet.js';
import WagerTransaction from '../../src/wager/wagerTransaction.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import type {SubmitWagerCommand, SubmitWagerOutcome, WagerResult} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import * as walletMapper from '../../src/wallet/wallet.mapper.js';
import * as txMapper from '../../src/wager/wagerTransaction.mapper.js';
import * as ledgerMapper from '../../src/wallet/walletLedgerEntry.mapper.js';

export const brl = (amount: string) => Money.from({amount, currency: 'BRL'});

export type WagerCommand = SubmitWagerCommand;

// Narrows the use case outcome for tests that never pass an inbox.
export function completed(outcome: SubmitWagerOutcome): WagerResult {
    if (outcome.kind !== 'completed') throw new Error(`expected a completed outcome, got ${outcome.kind}`);
    return outcome;
}

export const uniqueExternalId = () => `ext-${randomUUID()}`;

// A valid BET of 10.00 BRL with fresh external id and key; pass overrides to change anything.
export const betCommand = (o: Partial<WagerCommand> & Pick<WagerCommand, 'walletId' | 'playerId'>): WagerCommand => ({
    providerId: 'prov-1',
    externalTransactionId: uniqueExternalId(),
    idempotencyKey: `key-${randomUUID()}`,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    ...o,
});

export const runInParallel = <T>(n: number, fn: (i: number) => Promise<T>) =>
    Promise.all(Array.from({length: n}, (_, i) => fn(i)));

// Inserts a wallet the way CreateWallet will: wallet row, plus the OPENING transaction and ledger entry when
// the balance is not zero, so the ledger invariant already holds when the test starts.
export async function openWallet(orm: MikroORM, balance: string, currency = 'BRL') {
    const now = new Date();
    const walletId = randomUUID();
    const playerId = randomUUID();
    const wallet = Wallet.open({id: walletId, playerId, initialBalance: Money.from({amount: balance, currency}), now});
    const save = async (row: object) => {
        const em = orm.em.fork();
        em.persist(row);
        await em.flush();
    };

    await save(walletMapper.toRow(wallet));
    const entry = wallet.openingEntry({entryId: randomUUID(), transactionId: randomUUID(), now});
    if (entry) {
        const opening = WagerTransaction.create({
            id: entry.transactionId, providerId: 'internal', externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `opening:${walletId}`, walletId, playerId, roundId: 'opening', gameId: 'opening',
            kind: WagerTransactionKind.Opening, money: wallet.balance, now,
        });
        opening.markProcessed(undefined, now);
        await save(txMapper.toRow(opening, {balanceAfter: wallet.balance.toString()}));
        await save(ledgerMapper.toRow(entry));
    }
    return {walletId, playerId, currency};
}

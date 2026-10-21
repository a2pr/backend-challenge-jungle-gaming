import {describe, expect, it} from 'vitest';
import Money from '../../src/money/money.js';
import Wallet from '../../src/wallet/wallet.js';
import WagerTransaction from '../../src/wager/wagerTransaction.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import {FailureCode} from '../../src/wager/failureCode.js';
import {WalletBalanceChanged} from '../../src/events/walletBalanceChanged.js';
import {WagerTransactionProcessed} from '../../src/events/wagerTransactionProcessed.js';
import {WagerTransactionRejected} from '../../src/events/wagerTransactionRejected.js';
import {WagerTransactionPendingReference} from '../../src/events/wagerTransactionPendingReference.js';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const brl = (amount: string) => Money.from({amount, currency: 'BRL'});
const ctx = {eventId: 'ev-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: t0};

describe('WalletBalanceChanged', () => {
    it('serialises the README §11 envelope with MoneyProps strings', () => {
        const wallet = Wallet.open({id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0});
        const entry = wallet.debit(brl('80.00'), {entryId: 'e1', transactionId: 't1', now: t0});

        const json = JSON.parse(JSON.stringify(WalletBalanceChanged.from(wallet, entry, ctx)));

        expect(json).toEqual({
            eventId: 'ev-1', eventType: 'WalletBalanceChanged', aggregateId: 'w1',
            correlationId: 'corr-1', causationId: 'cause-1', occurredAt: '2026-01-01T00:00:00.000Z', version: 1,
            data: {
                walletId: 'w1', transactionId: 't1', direction: 'DEBIT',
                money: {amount: '80.00', currency: 'BRL'},
                balanceBefore: {amount: '100.00', currency: 'BRL'},
                balanceAfter: {amount: '20.00', currency: 'BRL'},
                walletVersion: 2,   // open = 1, the debit made it 2
            },
        });
    });

    it('leaves causationId out when there is none', () => {
        const wallet = Wallet.open({id: 'w1', playerId: 'p1', initialBalance: brl('10.00'), now: t0});
        const entry = wallet.credit(brl('1.00'), {entryId: 'e1', transactionId: 't1', now: t0});
        const {causationId: _omit, ...noCause} = ctx;

        const json = JSON.parse(JSON.stringify(WalletBalanceChanged.from(wallet, entry, noCause)));
        expect('causationId' in json).toBe(false);
    });
});

const bet = () => WagerTransaction.create({
    id: 't1', providerId: 'prov', externalTransactionId: 'ext-1', idempotencyKey: 'key-1', walletId: 'w1', playerId: 'p1',
    roundId: 'r1', gameId: 'g1', kind: WagerTransactionKind.Bet, money: brl('80.00'), now: t0,
});
const envelope = (eventType: string) => ({
    eventId: 'ev-1', eventType, aggregateId: 'w1', correlationId: 'corr-1', causationId: 'cause-1',
    occurredAt: '2026-01-01T00:00:00.000Z', version: 1,
});
const roundTrip = (event: unknown) => JSON.parse(JSON.stringify(event));

describe('WagerTransactionProcessed', () => {
    it('serialises the envelope, with the balance the caller observed', () => {
        const tx = bet();
        tx.markProcessed(undefined, t0);

        expect(roundTrip(WagerTransactionProcessed.from(tx, brl('20.00'), ctx))).toEqual({
            ...envelope('WagerTransactionProcessed'),
            data: {
                walletId: 'w1', transactionId: 't1', kind: 'BET', status: 'PROCESSED',
                money: {amount: '80.00', currency: 'BRL'}, balanceAfter: {amount: '20.00', currency: 'BRL'},
            },   // no referenceTransactionId: undefined is dropped by JSON
        });
    });
});

describe('WagerTransactionRejected', () => {
    it('carries the failure code and the unchanged balance', () => {
        const tx = bet();
        tx.reject(FailureCode.InsufficientFunds);

        expect(roundTrip(WagerTransactionRejected.from(tx, brl('20.00'), ctx))).toEqual({
            ...envelope('WagerTransactionRejected'),
            data: {
                walletId: 'w1', transactionId: 't1', kind: 'BET', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS',
                money: {amount: '80.00', currency: 'BRL'}, balanceAfter: {amount: '20.00', currency: 'BRL'},
            },
        });
    });

    it('refuses a transaction that was not rejected (no failure code)', () => {
        expect(() => WagerTransactionRejected.from(bet(), brl('20.00'), ctx)).toThrow(/no failure code/);
    });
});

describe('WagerTransactionPendingReference', () => {
    const refund = () => WagerTransaction.create({
        id: 't2', providerId: 'prov', externalTransactionId: 'ext-2', idempotencyKey: 'key-2', walletId: 'w1', playerId: 'p1',
        roundId: 'r1', gameId: 'g1', kind: WagerTransactionKind.Refund, money: brl('80.00'),
        referenceExternalTransactionId: 'ext-1', now: t0,
    });

    it('names the awaited provider id and when the next attempt is due', () => {
        const tx = refund();
        tx.markPendingReference(t0);

        const json = roundTrip(WagerTransactionPendingReference.from(tx, ctx));

        expect(json).toEqual({
            ...envelope('WagerTransactionPendingReference'),
            data: {
                walletId: 'w1', transactionId: 't2', kind: 'REFUND', referenceExternalTransactionId: 'ext-1',
                nextAttemptAt: tx.nextAttemptAt!.toISOString(),
            },
        });
        expect(tx.nextAttemptAt!.getTime()).toBeGreaterThan(t0.getTime());   // a retry is scheduled in the future
    });

    it('refuses a transaction that is not waiting for a reference', () => {
        expect(() => WagerTransactionPendingReference.from(refund(), ctx)).toThrow(/not waiting/);   // still PENDING
        expect(() => WagerTransactionPendingReference.from(bet(), ctx)).toThrow(/not waiting/);      // BET has no reference
    });
});

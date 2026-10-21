import {describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {toBody, toResponse, toStoredBody} from '../../../src/http/transactionResponse.js';
import type {WagerResult} from '../../../src/wager/SubmitWagerTransaction.usecase.js';
import {FailureCode} from '../../../src/wager/failureCode.js';
import Money from '../../../src/money/money.js';
import WagerTransaction from '../../../src/wager/wagerTransaction.js';
import {WagerTransactionKind} from '../../../src/wager/wagerTransactionKind.js';
import {WagerTransactionStatus} from '../../../src/wager/wagerTransactionStatus.js';

const result = (o: Partial<WagerResult> = {}): WagerResult => ({
    kind: 'completed', transactionId: 'tx-1', status: WagerTransactionStatus.Processed,
    balance: {amount: '75.00', currency: 'BRL'}, idempotentReplay: false, ...o,
});

describe('toResponse (D9)', () => {
    it.each([
        [WagerTransactionStatus.Processed, 200],
        [WagerTransactionStatus.PendingReference, 202],
        [WagerTransactionStatus.Rejected, 422],
        [WagerTransactionStatus.Failed, 409],
    ])('%s answers %i', (status, http) => {
        expect(toResponse(result({status})).status).toBe(http);
    });

    it('a replay keeps the status of the stored outcome and says so', () => {
        const replayedRejection = toResponse(result({
            status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds, idempotentReplay: true,
        }));
        expect(replayedRejection.status).toBe(422);
        expect(replayedRejection.body.idempotentReplay).toBe(true);
    });

    it('PENDING is never stored, so it has no status', () => {
        expect(() => toResponse(result({status: WagerTransactionStatus.Pending}))).toThrow(/no HTTP status/);
    });
});

describe('toBody', () => {
    it('is the README body', () => {
        expect(toBody(result())).toEqual({
            transactionId: 'tx-1', status: 'PROCESSED', balance: {amount: '75.00', currency: 'BRL'}, idempotentReplay: false,
        });
    });

    it('carries failureCode only when there is one', () => {
        expect(toBody(result())).not.toHaveProperty('failureCode');
        expect(toBody(result({status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds})))
            .toMatchObject({failureCode: 'INSUFFICIENT_FUNDS'});
    });
});

describe('toStoredBody', () => {
    const now = new Date();
    const bet = () => WagerTransaction.create({
        id: randomUUID(), providerId: 'prov', externalTransactionId: 'ext-1', idempotencyKey: 'key-1', walletId: randomUUID(),
        playerId: randomUUID(), roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet,
        money: Money.from({amount: '10.00', currency: 'BRL'}), now,
    });

    it('builds the body from the stored row: balanceAfter, the transaction currency, never a replay', () => {
        const transaction = bet();
        transaction.markProcessed(undefined, now);

        expect(toStoredBody({transaction, balanceAfter: '90.00'})).toEqual({
            transactionId: transaction.id, status: 'PROCESSED', balance: {amount: '90.00', currency: 'BRL'}, idempotentReplay: false,
        });
    });

    it('carries the failureCode of a rejected row', () => {
        const transaction = bet();
        transaction.reject(FailureCode.InsufficientFunds);

        expect(toStoredBody({transaction, balanceAfter: '5.00'})).toMatchObject({status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS'});
    });

    it('a row without balanceAfter is a bug, not a request error', () => {
        expect(() => toStoredBody({transaction: bet(), balanceAfter: null})).toThrow(/no balanceAfter/);
    });
});

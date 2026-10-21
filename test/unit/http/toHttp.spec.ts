import {HttpException, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {describe, expect, it} from 'vitest';
import {BadRequestError} from '../../../src/http/errors.js';
import {toHttp} from '../../../src/http/toHttp.js';
import {InvalidMoneyError, CurrencyMismatchError} from '../../../src/money/errors.js';
import {
    DuplicateExternalTransactionError, IdempotencyConflictError, InvalidTransactionStateError,
    InvalidWagerTransactionError, TransactionNotFoundError, WalletNotFoundError,
} from '../../../src/wager/errors.js';
import {WagerTransactionStatus} from '../../../src/wager/wagerTransactionStatus.js';
import {DuplicateWalletError, InvalidMovementError} from '../../../src/wallet/errors.js';

const pgError = Object.assign(new Error('canceling statement due to lock timeout'), {code: '55P03'});

describe('toHttp (D9)', () => {
    it.each([
        [new BadRequestError('bad'), 400, 'VALIDATION_ERROR'],
        [new InvalidMoneyError('bad'), 400, 'VALIDATION_ERROR'],
        [new CurrencyMismatchError('BRL', 'USD'), 400, 'VALIDATION_ERROR'],
        [new InvalidWagerTransactionError('bad'), 400, 'VALIDATION_ERROR'],
        [new InvalidMovementError('bad'), 400, 'VALIDATION_ERROR'],
        [new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
        [new TransactionNotFoundError('t'), 404, 'TRANSACTION_NOT_FOUND'],
        [new IdempotencyConflictError('p', 'k'), 409, 'IDEMPOTENCY_CONFLICT'],
        [new DuplicateExternalTransactionError('p', 'e'), 409, 'DUPLICATE_EXTERNAL_TRANSACTION'],
        [new DuplicateWalletError('p', 'BRL'), 409, 'DUPLICATE_WALLET'],
        [new InvalidTransactionStateError(WagerTransactionStatus.Processed, WagerTransactionStatus.Failed), 500, 'INVALID_STATE'],
        [new Error('connection terminated'), 503, 'TEMPORARILY_UNAVAILABLE'],
        ['not an error', 500, 'INTERNAL_ERROR'],
    ])('%s', (error, status, code) => {
        expect(toHttp(error)).toMatchObject({status, code});
    });

    it('maps a lock timeout to a retryable 503 with Retry-After, also when wrapped', () => {
        const wrapped = new Error('driver', {cause: pgError});
        for (const error of [pgError, wrapped]) {
            expect(toHttp(error)).toMatchObject({status: 503, retryable: true, headers: {'Retry-After': '1'}});
        }
    });

    it('only the 503 is retryable', () => {
        expect(toHttp(new IdempotencyConflictError('p', 'k')).retryable).toBe(false);
        expect(toHttp(new Error('x')).retryable).toBe(true);
    });

    it('keeps the zod issues of a bad request in details', () => {
        expect(toHttp(new BadRequestError('bad', [{path: ['amount']}])).details).toEqual([{path: ['amount']}]);
    });

    it('does not leak the message of a bug or an infrastructure error', () => {
        expect(toHttp(new Error('password=secret host=db')).message).not.toContain('secret');
    });

    it('keeps the readiness checks of a 503 HttpException in details', () => {
        expect(toHttp(new ServiceUnavailableException({postgres: false, sqs: true})))
            .toMatchObject({status: 503, retryable: true, details: {postgres: false, sqs: true}});
    });

    it('keeps the status of Nest\'s own errors (unknown route, bad JSON)', () => {
        expect(toHttp(new NotFoundException())).toMatchObject({status: 404, retryable: false});
        expect(toHttp(new HttpException('x', 413)).status).toBe(413);
    });
});

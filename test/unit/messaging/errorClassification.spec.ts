import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {classify} from '../../../src/messaging/errorClassification.js';
import {InboxPayloadMismatchError} from '../../../src/messaging/errors.js';
import {CurrencyMismatchError, InvalidMoneyError} from '../../../src/money/errors.js';
import {InvalidMovementError} from '../../../src/wallet/errors.js';
import {
    DuplicateExternalTransactionError, IdempotencyConflictError, InvalidTransactionStateError,
    InvalidWagerTransactionError, TransactionNotFoundError, WalletNotFoundError,
} from '../../../src/wager/errors.js';
import {WagerTransactionStatus} from '../../../src/wager/wagerTransactionStatus.js';

const zodError = z.string().safeParse(1).error;

describe('classify', () => {
    it.each<[string, unknown]>([
        ['ZodError', zodError],
        ['SyntaxError (unparsable JSON)', new SyntaxError('Unexpected token')],
        ['InvalidMoneyError', new InvalidMoneyError('x')],
        ['CurrencyMismatchError', new CurrencyMismatchError('BRL', 'USD')],
        ['InvalidWagerTransactionError', new InvalidWagerTransactionError('x')],
        ['InvalidMovementError', new InvalidMovementError('x')],
        ['IdempotencyConflictError', new IdempotencyConflictError('p', 'k')],
        ['DuplicateExternalTransactionError', new DuplicateExternalTransactionError('p', 'e')],
        ['WalletNotFoundError', new WalletNotFoundError('w')],
        ['InboxPayloadMismatchError', new InboxPayloadMismatchError('c', 'm')],
    ])('%s is permanent', (_, error) => {
        expect(classify(error)).toBe('permanent');
    });

    it.each<[string, unknown]>([
        ['plain Error', new Error('connection reset')],
        ['deadlock 40P01', {code: '40P01'}],
        ['serialization 40001', {code: '40001'}],
        ['lock timeout 55P03', Object.assign(new Error('lock timeout'), {code: '55P03'})],
        ['InvalidTransactionStateError (a bug: retry, then FAILED)', new InvalidTransactionStateError(WagerTransactionStatus.Processed, WagerTransactionStatus.Pending)],
        ['TransactionNotFoundError (read path only, unknown here)', new TransactionNotFoundError('t')],
        ['non-Error throw', 'boom'],
    ])('%s is transient', (_, error) => {
        expect(classify(error)).toBe('transient');
    });
});

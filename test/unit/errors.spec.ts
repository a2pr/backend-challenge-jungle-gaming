import {describe, expect, it} from 'vitest';
import {
    DuplicateExternalTransactionError, IdempotencyConflictError, WalletNotFoundError,
} from '../../src/wager/errors.js';
import {DuplicateWalletError} from '../../src/wallet/errors.js';

describe('request errors carry the fields the HTTP filter reads', () => {
    it.each([
        [new WalletNotFoundError('w-1'), 'WalletNotFoundError', {walletId: 'w-1'}, 'w-1'],
        [new IdempotencyConflictError('prov', 'key-1'), 'IdempotencyConflictError', {providerId: 'prov', idempotencyKey: 'key-1'}, 'key-1'],
        [new DuplicateExternalTransactionError('prov', 'ext-1'), 'DuplicateExternalTransactionError', {providerId: 'prov', externalTransactionId: 'ext-1'}, 'ext-1'],
        [new DuplicateWalletError('p-1', 'BRL'), 'DuplicateWalletError', {playerId: 'p-1', currency: 'BRL'}, 'p-1'],
    ])('%s', (error, name, fields, inMessage) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.constructor.name).toBe(name);
        expect(error.name).toBe(name);
        expect(error).toMatchObject(fields);
        expect(error.message).toContain(inMessage);
    });
});

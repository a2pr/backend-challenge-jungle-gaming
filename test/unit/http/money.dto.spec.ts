import {describe, expect, it} from 'vitest';
import {moneySchema} from '../../../src/http/dto/money.dto.js';
import {createWalletSchema} from '../../../src/http/dto/createWallet.dto.js';

const money = (amount: string, currency = 'BRL') => ({amount, currency});

describe('moneySchema', () => {
    it.each(['0.00', '10.50', '25.00', '9999999999999999.99'])('accepts %s', (amount) => {
        expect(moneySchema.safeParse(money(amount)).success).toBe(true);
    });

    it.each(['-1.00', '1.5', '1', '1.555', '1e3', 'abc', '', ' 1.00', '10000000000000000.00', '.50'])('rejects amount %j', (amount) => {
        expect(moneySchema.safeParse(money(amount)).success).toBe(false);
    });

    it.each(['brl', 'BR', 'BRLL', '', 'B1L'])('rejects currency %j', (currency) => {
        expect(moneySchema.safeParse(money('1.00', currency)).success).toBe(false);
    });

    it('rejects a number instead of a string', () => {
        expect(moneySchema.safeParse({amount: 1, currency: 'BRL'}).success).toBe(false);
    });
});

describe('createWalletSchema', () => {
    const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

    it('accepts the README body, and a zero balance', () => {
        expect(createWalletSchema.safeParse({playerId, initialBalance: money('1000.00')}).success).toBe(true);
        expect(createWalletSchema.safeParse({playerId, initialBalance: money('0.00')}).success).toBe(true);
    });

    it.each([
        ['missing playerId', {initialBalance: money('1.00')}],
        ['playerId not a uuid', {playerId: 'player-1', initialBalance: money('1.00')}],
        ['missing initialBalance', {playerId}],
        ['null body', null],
    ])('rejects %s', (_name, body) => {
        expect(createWalletSchema.safeParse(body).success).toBe(false);
    });
});

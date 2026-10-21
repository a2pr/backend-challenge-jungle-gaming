import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {submitTransactionSchema, toCommand} from '../../../src/http/dto/submitTransaction.dto.js';
import Money from '../../../src/money/money.js';

const valid = () => ({
    providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId: randomUUID(), walletId: randomUUID(),
    roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: {amount: '25.00', currency: 'BRL'},
});

describe('submitTransactionSchema', () => {
    it.each(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])('accepts kind %s', (kind) => {
        expect(submitTransactionSchema.safeParse({...valid(), kind}).success).toBe(true);
    });

    it('accepts an optional reference', () => {
        const parsed = submitTransactionSchema.safeParse({...valid(), kind: 'REFUND', referenceExternalTransactionId: 'bet-1'});
        expect(parsed.success).toBe(true);
    });

    it.each([
        ['OPENING is internal', {kind: 'OPENING'}],
        ['unknown kind', {kind: 'TIP'}],
        ['lowercase kind', {kind: 'bet'}],
        ['walletId not a uuid', {walletId: 'wallet-1'}],
        ['playerId not a uuid', {playerId: 'player-1'}],
        ['blank providerId', {providerId: ''}],
        ['missing roundId', {roundId: undefined}],
        ['empty reference', {referenceExternalTransactionId: ''}],
        ['amount 1.5', {money: {amount: '1.5', currency: 'BRL'}}],
        ['negative amount', {money: {amount: '-1.00', currency: 'BRL'}}],
        ['exponent amount', {money: {amount: '1e3', currency: 'BRL'}}],
        ['amount as a number', {money: {amount: 25, currency: 'BRL'}}],
        ['lowercase currency', {money: {amount: '1.00', currency: 'brl'}}],
        ['missing money', {money: undefined}],
    ])('rejects %s', (_name, patch) => {
        expect(submitTransactionSchema.safeParse({...valid(), ...patch}).success).toBe(false);
    });

    it('does not decide kind rules (zero BET passes the shape check; the domain rejects it)', () => {
        expect(submitTransactionSchema.safeParse({...valid(), money: {amount: '0.00', currency: 'BRL'}}).success).toBe(true);
    });
});

describe('toCommand', () => {
    it('adds the header key and converts money to Money', () => {
        const dto = submitTransactionSchema.parse(valid());
        const command = toCommand(dto, 'provider-a:transaction-123');

        expect(command.idempotencyKey).toBe('provider-a:transaction-123');
        expect(command.money).toBeInstanceOf(Money);
        expect(command.money.toJSON()).toEqual({amount: '25.00', currency: 'BRL'});
        expect(command.referenceExternalTransactionId).toBeUndefined();
    });
});

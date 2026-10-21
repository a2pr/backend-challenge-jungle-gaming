import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {ZodError} from 'zod';
import {toCommand, wagerMessageSchema} from '../../../src/messaging/messageSchema.js';
import Money from '../../../src/money/money.js';

const valid = () => ({
    messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
        providerId: 'provider-a', externalTransactionId: 'transaction-123', idempotencyKey: 'provider-a:transaction-123',
        playerId: randomUUID(), walletId: randomUUID(), roundId: 'round-987', gameId: 'fortune-chimp',
        kind: 'BET', money: {amount: '25.00', currency: 'BRL'},
    },
});
const parse = (m: unknown) => wagerMessageSchema.parse(m);

describe('wagerMessageSchema + toCommand', () => {
    it('a valid body becomes the command HTTP would build', () => {
        const m = valid();
        expect(toCommand(parse(m))).toEqual({...m.data, money: Money.from(m.data.money)});
    });

    it.each([
        ['missing field', (m: any) => delete m.data.roundId],
        ['OPENING', (m: any) => (m.data.kind = 'OPENING')],
        ['amount 1.5', (m: any) => (m.data.money.amount = '1.5')],
        ['missing idempotencyKey', (m: any) => delete m.data.idempotencyKey],
        ['wrong type', (m: any) => (m.type = 'Other')],
    ])('%s throws ZodError', (_, mutate) => {
        const m = valid();
        mutate(m);
        expect(() => parse(m)).toThrow(ZodError);
    });

    it('unparsable JSON throws SyntaxError', () => {
        expect(() => parse(JSON.parse('{not json'))).toThrow(SyntaxError);
    });
});

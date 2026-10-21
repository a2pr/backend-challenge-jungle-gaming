import {describe, expect, it} from 'vitest';
import {InboxMessage} from '../../../src/messaging/inboxMessage.js';

const t0 = new Date('2026-10-21T12:00:00Z');
const fresh = () => InboxMessage.receive({consumerName: 'wager-consumer', messageId: 'm1', payloadHash: 'h', now: t0});

describe('InboxMessage', () => {
    it('receive is unprocessed and stamped with now', () => {
        const m = fresh();
        expect(m.isProcessed()).toBe(false);
        expect(m.receivedAt).toBe(t0);
    });

    it('markProcessed sets processedAt once', () => {
        const m = fresh();
        m.markProcessed(t0);
        expect(m.isProcessed()).toBe(true);
        expect(m.processedAt).toBe(t0);
        expect(() => m.markProcessed(t0)).toThrow();
    });

    it('rehydrate keeps the stored state', () => {
        const m = InboxMessage.rehydrate({consumerName: 'c', messageId: 'm', payloadHash: 'h', receivedAt: t0, processedAt: t0});
        expect(m.isProcessed()).toBe(true);
    });
});

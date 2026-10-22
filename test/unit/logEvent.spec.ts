import {describe, expect, it} from 'vitest';
import {logEvent} from '../../src/observability/logEvent.js';
import {INSTANCE_ID} from '../../src/observability/instance.js';

const fakeLogger = () => {
    const lines: { level: string; message: any }[] = [];
    const at = (level: string) => (message: any) => { lines.push({level, message}); };
    return {lines, logger: {log: at('log'), warn: at('warn'), error: at('error')}};
};

describe('logEvent', () => {
    it('writes the event name, the instance id and the ids, at the level asked', () => {
        const {lines, logger} = fakeLogger();

        logEvent(logger, 'wager.processed', {correlationId: 'abc', walletId: 'w1', transactionId: 't1', providerId: 'p1', status: 'PROCESSED'});
        logEvent(logger, 'consumer.retry', {messageId: 'm1'}, 'warn');

        expect(lines).toEqual([
            {level: 'log', message: {event: 'wager.processed', instanceId: INSTANCE_ID, correlationId: 'abc', walletId: 'w1', transactionId: 't1', providerId: 'p1', status: 'PROCESSED'}},
            {level: 'warn', message: {event: 'consumer.retry', instanceId: INSTANCE_ID, messageId: 'm1'}},
        ]);
    });

    it('has no field for amounts or bodies: they do not compile, which is the allow-list', () => {
        const {logger} = fakeLogger();

        // @ts-expect-error amount is not in the allow-list
        logEvent(logger, 'x', {amount: '10.00'});
        // @ts-expect-error neither is a request body
        logEvent(logger, 'x', {body: {money: {amount: '10.00'}}});
    });
});

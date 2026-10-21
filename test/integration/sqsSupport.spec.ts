import {beforeAll, describe, expect, it} from 'vitest';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {createTestQueues, purge, receiveAll, sqs} from '../support/sqs.js';

let queues: Awaited<ReturnType<typeof createTestQueues>>;
beforeAll(async () => {
    queues = await createTestQueues();
});

describe('sqs test support', () => {
    it('a fresh queue is empty', async () => {
        expect(await receiveAll(queues.eventsQueueUrl)).toEqual([]);
    });

    it('createTestQueues returns working urls and receiveAll returns a sent message', async () => {
        await sqs.send(new SendMessageCommand({QueueUrl: queues.eventsQueueUrl, MessageBody: 'hello'}));
        const messages = await receiveAll(queues.eventsQueueUrl);
        expect(messages.map((m) => m.Body)).toEqual(['hello']);
    });

    it('purge empties a queue', async () => {
        await sqs.send(new SendMessageCommand({QueueUrl: queues.eventsQueueUrl, MessageBody: 'x'}));
        await purge(queues.eventsQueueUrl);
        expect(await receiveAll(queues.eventsQueueUrl)).toEqual([]);
    });
});

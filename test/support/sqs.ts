import {randomUUID} from 'node:crypto';
import {CreateQueueCommand, Message, PurgeQueueCommand, ReceiveMessageCommand, SQSClient} from '@aws-sdk/client-sqs';

// Endpoint, region and credentials come from AWS_* env vars (.env).
export const sqs = new SQSClient({maxAttempts: 1, useQueueUrlAsEndpoint: false});

// Uniquely named throwaway queues, 2 s visibility so redelivery tests do not wait 30 s. Never the compose queues.
export async function createTestQueues() {
    const suffix = randomUUID().slice(0, 8);
    const create = async (name: string, fifo: boolean) => {
        const {QueueUrl} = await sqs.send(new CreateQueueCommand({
            QueueName: fifo ? `test-${name}-${suffix}.fifo` : `test-${name}-${suffix}`,
            Attributes: {VisibilityTimeout: '2', ...(fifo ? {FifoQueue: 'true'} : {})},
        }));
        return QueueUrl!;
    };
    return {
        wagerQueueUrl: await create('wager-transactions', true),
        wagerDlqUrl: await create('wager-transactions-dlq', true),
        eventsQueueUrl: await create('wager-events', false),
    };
}

// Drains the queue. Messages stay invisible for 2 s after this, so a second call right away returns [].
export async function receiveAll(queueUrl: string): Promise<Message[]> {
    const all: Message[] = [];
    for (;;) {
        const {Messages = []} = await sqs.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            MessageAttributeNames: ['All'],
        }));
        if (Messages.length === 0) return all;
        all.push(...Messages);
    }
}

export const purge = async (queueUrl: string): Promise<void> => {
    await sqs.send(new PurgeQueueCommand({QueueUrl: queueUrl}));
};

import {randomUUID} from 'node:crypto';
import {CreateQueueCommand, GetQueueAttributesCommand, Message, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient} from '@aws-sdk/client-sqs';
import type {TestingModuleBuilder} from '@nestjs/testing';
import {MESSAGING_CONFIG, messagingConfig} from '../../src/messaging/messaging.config.js';
import {createTestApp} from './app.js';

// Endpoint, region and credentials come from AWS_* env vars (.env).
export const sqs = new SQSClient({maxAttempts: 1, useQueueUrlAsEndpoint: false});

// Uniquely named throwaway queues, 2 s visibility so redelivery tests do not wait 30 s. Never the compose queues.
export async function createTestQueues() {
    const suffix = randomUUID().slice(0, 8);
    const create = async (name: string, fifo: boolean, extra: Record<string, string> = {}) => {
        const {QueueUrl} = await sqs.send(new CreateQueueCommand({
            QueueName: fifo ? `test-${name}-${suffix}.fifo` : `test-${name}-${suffix}`,
            Attributes: {VisibilityTimeout: '2', ...(fifo ? {FifoQueue: 'true'} : {}), ...extra},
        }));
        return QueueUrl!;
    };
    const wagerDlqUrl = await create('wager-transactions-dlq', true);
    const {Attributes} = await sqs.send(new GetQueueAttributesCommand({QueueUrl: wagerDlqUrl, AttributeNames: ['QueueArn']}));
    // Same redrive as the compose queue (maxReceiveCount = WAGER_MAX_RECEIVE_COUNT), so SQS itself moves a message that is never deleted.
    const redrive = JSON.stringify({deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: String(messagingConfig().wagerMaxReceiveCount)});
    const wagerQueueUrl = await create('wager-transactions', true, {RedrivePolicy: redrive});
    return {wagerQueueUrl, wagerDlqUrl, eventsQueueUrl: await create('wager-events', false)};
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

// Producer side of the FIFO queue: group = walletId (per-wallet order), dedup id = messageId (broker drops repeats for 5 min).
export const sendWagerMessage = async (queueUrl: string, body: { messageId: string, data: { walletId: string } }, dedupId = body.messageId): Promise<void> => {
    await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: body.data.walletId,
        MessageDeduplicationId: dedupId,   // pass another one to deliver the same messageId twice
    }));
};

// Real app pointed at throwaway queues, timers off unless `workers` (tests call pollOnce()/tick() themselves). `overrides` is for failure injection.
export async function buildApp(opts: { queues: Awaited<ReturnType<typeof createTestQueues>>, overrides?: (b: TestingModuleBuilder) => TestingModuleBuilder, workers?: boolean }) {
    const {app} = await createTestApp((b) => {
        b.overrideProvider(MESSAGING_CONFIG).useValue({...messagingConfig(), ...opts.queues, workersEnabled: opts.workers ?? false});
        return opts.overrides ? opts.overrides(b) : b;
    });
    return app;
}

// Visible plus in flight: zero means the message is really gone, not just hidden by the visibility timeout.
export async function queueDepth(queueUrl: string): Promise<number> {
    const {Attributes = {}} = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

// The real client, except that `match` commands throw `times` times (failure injection by override, not flags in production code).
export const flakySqs = (match: (command: object) => boolean, times = Infinity) => {
    let left = times;
    return {send: (command: any, options?: any) => match(command) && left-- > 0 ? Promise.reject(new Error('sqs injected failure')) : sqs.send(command, options)};
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

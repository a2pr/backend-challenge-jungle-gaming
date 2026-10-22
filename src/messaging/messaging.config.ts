export const MESSAGING_CONFIG = Symbol('MESSAGING_CONFIG');

export interface MessagingConfig {
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
    workersEnabled: boolean;
    outboxPollMs: number;
    pendingPollMs: number;
    wagerMaxReceiveCount: number;   // must equal the queue's maxReceiveCount (localstack init script)
}

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
};

export function messagingConfig(): MessagingConfig {
    return {
        wagerQueueUrl: required('WAGER_QUEUE_URL'),
        wagerDlqUrl: required('WAGER_DLQ_URL'),
        eventsQueueUrl: required('EVENTS_QUEUE_URL'),
        workersEnabled: process.env.WORKERS_ENABLED !== 'false',
        outboxPollMs: Number(process.env.OUTBOX_POLL_MS ?? 1000),
        pendingPollMs: Number(process.env.PENDING_POLL_MS ?? 5000),
        wagerMaxReceiveCount: Number(process.env.WAGER_MAX_RECEIVE_COUNT ?? 5),
    };
}

export interface MessagingConfig {
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
    workersEnabled: boolean;
    outboxPollMs: number;
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
    };
}

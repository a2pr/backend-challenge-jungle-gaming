import {IntegrationEvent} from "../events/integrationEvent.js";
import {backoffMs} from "../wager/backoff.js";

export const OUTBOX_BACKOFF = {baseMs: 5_000, capMs: 300_000} as const;

export interface OutboxMessageProps {
    id: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date,
    publishedAt: Date | null,
}

export class OutboxMessage {
    private constructor(
        public readonly id: string,
        public readonly aggregateId: string,
        public readonly eventType: string,
        public readonly payload: Record<string, unknown>,
        public readonly occurredAt: Date,
        private _attempts: number,
        private _nextAttemptAt: Date,
        private _publishedAt: Date | null,
    ) {
    }

    /** Born pending and due immediately. */
    static enqueue(input: { id: string, event: IntegrationEvent<unknown>, now: Date }): OutboxMessage {
        const {id, event, now} = input;
        return new OutboxMessage(
            id, event.aggregateId, event.eventType,
            event.toJSON() as unknown as Record<string, unknown>,
            event.occurredAt, 0, now, null,
        );
    }

    static rehydrate(props: OutboxMessageProps): OutboxMessage {
        return new OutboxMessage(
            props.id, props.aggregateId, props.eventType, props.payload,
            props.occurredAt, props.attempts, props.nextAttemptAt, props.publishedAt,
        );
    }

    get attempts(): number {
        return this._attempts;
    }

    get nextAttemptAt(): Date {
        return this._nextAttemptAt;
    }

    get publishedAt(): Date | null {
        return this._publishedAt;
    }

    isPending(): boolean {
        return this._publishedAt === null;
    }

    isDue(now: Date): boolean {
        return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
    }

    markPublished(now: Date): void {
        if (!this.isPending()) {
            throw new Error(`outbox message ${this.id} is already published`);
        }
        this._publishedAt = now;
    }

    scheduleRetry(now: Date): void {
        if (!this.isPending()) {
            throw new Error(`outbox message ${this.id} is already published`);
        }
        // delay uses the attempts made so far, then the counter moves: 5 s, 10 s, 20 s ...
        this._nextAttemptAt = new Date(now.getTime() + backoffMs(this._attempts, OUTBOX_BACKOFF.baseMs, OUTBOX_BACKOFF.capMs));
        this._attempts += 1;
    }
}

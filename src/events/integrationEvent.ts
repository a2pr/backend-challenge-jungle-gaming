// What the caller supplies for every event: ids and the clock come from outside (D17), so tests are deterministic.
export interface EventContext {
    eventId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
    aggregateId: string;
    data: T;
}

export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    readonly eventId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
    readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = props.occurredAt;
        this.data = props.data;
    }

    /** Envelope serializado gravado no payload da outbox. Same for every event, so subclasses do not repeat it. */
    toJSON() {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            causationId: this.causationId,
            occurredAt: this.occurredAt.toISOString(),
            version: this.version,
            data: this.data,
        };
    }
}

import {EntitySchema} from "@mikro-orm/core";

// Mirrors outbox_messages. No domain class, so rows are used directly (no mapper).
export class OutboxMessageRow {
    id!: string;               // the event id
    aggregateId!: string;
    eventType!: string;
    payload!: Record<string, unknown>;
    occurredAt!: Date;
    attempts!: number;
    nextAttemptAt!: Date;
    publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
    class: OutboxMessageRow,
    tableName: 'outbox_messages',
    properties: {
        id: {type: 'uuid', primary: true},
        aggregateId: {type: 'uuid'},
        eventType: {type: 'string'},
        payload: {type: 'json', columnType: 'jsonb'},
        occurredAt: {type: 'Date', columnType: 'timestamptz'},
        attempts: {type: 'integer', default: 0},
        nextAttemptAt: {type: 'Date', columnType: 'timestamptz'},
        publishedAt: {type: 'Date', columnType: 'timestamptz', nullable: true},
    }
})

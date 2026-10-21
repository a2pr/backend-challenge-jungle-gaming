import {EntitySchema} from "@mikro-orm/core";

// Mirrors outbox_messages. The publisher goes through OutboxMessage (outboxMessage.mapper.ts); enqueue still inserts rows directly.
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

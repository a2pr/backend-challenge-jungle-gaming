import {OutboxMessageRow} from "./outboxMessage.schema.js";
import {OutboxMessage} from "./outboxMessage.js";

export function toDomain(row: OutboxMessageRow): OutboxMessage {
    return OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        publishedAt: row.publishedAt,
    })
}

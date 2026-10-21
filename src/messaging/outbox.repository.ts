import {Injectable} from "@nestjs/common";
import {EntityManager} from "@mikro-orm/core";
import {IntegrationEvent} from "../events/integrationEvent.js";
import {OutboxMessageRow} from "./outboxMessage.schema.js";

@Injectable()
export class OutboxRepository {
    // Enqueue half only. Rows are due immediately: next_attempt_at = occurredAt.
    async enqueue(em: EntityManager, events: IntegrationEvent<unknown>[]): Promise<void> {
        if (events.length === 0) return;
        await em.insertMany(OutboxMessageRow, events.map((event): OutboxMessageRow => ({
            id: event.eventId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.toJSON() as unknown as Record<string, unknown>,
            occurredAt: event.occurredAt,
            attempts: 0,
            nextAttemptAt: event.occurredAt,
            publishedAt: null,
        })));
    }
}

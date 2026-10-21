import {Injectable} from "@nestjs/common";
import {EntityManager} from "@mikro-orm/core";
import {IntegrationEvent} from "../events/integrationEvent.js";
import {OutboxMessageRow} from "./outboxMessage.schema.js";
import {OutboxMessage} from "./outboxMessage.js";
import {toDomain} from "./outboxMessage.mapper.js";

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

    // Must run inside em.transactional: the row locks last until that transaction ends.
    // Raw SQL returns column names, so each is aliased to the OutboxMessageRow property the mapper reads.
    async claimDue(em: EntityManager, now: Date, limit: number): Promise<OutboxMessage[]> {
        const rows: Record<string, any>[] = await em.getConnection().execute(
            `SELECT id, aggregate_id AS "aggregateId", event_type AS "eventType", payload,
                    occurred_at AS "occurredAt", attempts, next_attempt_at AS "nextAttemptAt", published_at AS "publishedAt"
             FROM outbox_messages
             WHERE published_at IS NULL AND next_attempt_at <= ?
             ORDER BY next_attempt_at
             LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [now, limit],
            'all',
            em.getTransactionContext(), // join the caller's transaction, or the lock is released at once
        );
        // execute() skips MikroORM's hydration: timestamptz arrives as a string ('2026-10-21 12:00:00+00'), not a Date.
        return rows.map((r) => toDomain({
            ...r,
            occurredAt: new Date(r.occurredAt),
            nextAttemptAt: new Date(r.nextAttemptAt),
            publishedAt: r.publishedAt && new Date(r.publishedAt),
        } as OutboxMessageRow));
    }

    // No version check: the claim holds the row lock, nobody else can change it meanwhile.
    async save(em: EntityManager, message: OutboxMessage): Promise<void> {
        const updated = await em.nativeUpdate(
            OutboxMessageRow,
            {id: message.id},
            {attempts: message.attempts, nextAttemptAt: message.nextAttemptAt, publishedAt: message.publishedAt},
        );
        if (updated !== 1) throw new Error(`outbox message ${message.id} not found`);
    }
}

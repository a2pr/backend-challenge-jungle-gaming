import {EntityManager} from "@mikro-orm/core";
import {InboxMessageRow} from "./inboxMessage.schema.js";

export interface InboxMessage {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    receivedAt: Date;
}

export class InboxRepository {
    // true: first time this (consumer, message) is seen. false: already committed, the caller acks and skips.
    // A concurrent duplicate blocks on the primary key until the first transaction ends, then returns false.
    async tryInsert(em: EntityManager, message: InboxMessage): Promise<boolean> {
        const rows = await em.getConnection().execute(
            `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (consumer_name, message_id) DO NOTHING
             RETURNING message_id`,
            [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
            'all',
            em.getTransactionContext(), // without it the statement runs on another connection, outside the transaction
        );
        return rows.length > 0;
    }

    async markProcessed(em: EntityManager, consumerName: string, messageId: string, at: Date): Promise<void> {
        await em.nativeUpdate(InboxMessageRow, {consumerName, messageId}, {processedAt: at});
    }
}

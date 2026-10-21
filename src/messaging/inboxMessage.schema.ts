import {EntitySchema} from "@mikro-orm/core";

// Mirrors inbox_messages. No domain class, so rows are used directly (no mapper).
// Composite primary key: the same message id may arrive at different consumers.
export class InboxMessageRow {
    consumerName!: string;
    messageId!: string;
    payloadHash!: string;
    receivedAt!: Date;
    processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
    class: InboxMessageRow,
    tableName: 'inbox_messages',
    properties: {
        consumerName: {type: 'string', primary: true},
        messageId: {type: 'string', primary: true},
        payloadHash: {type: 'string', columnType: 'char(64)'},
        receivedAt: {type: 'Date', columnType: 'timestamptz'},
        processedAt: {type: 'Date', columnType: 'timestamptz', nullable: true},
    }
})

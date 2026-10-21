export interface InboxMessageProps {
    consumerName: string,
    messageId: string,
    payloadHash: string,
    receivedAt: Date,
    processedAt: Date | null,
}

// Domain shape only (README §6.5). The insert is InboxRepository.tryInsert; this class is not persisted through a mapper.
export class InboxMessage {
    private constructor(
        public readonly consumerName: string,
        public readonly messageId: string,
        public readonly payloadHash: string,
        public readonly receivedAt: Date,
        private _processedAt: Date | null,
    ) {
    }

    static receive(input: { consumerName: string, messageId: string, payloadHash: string, now: Date }): InboxMessage {
        return new InboxMessage(input.consumerName, input.messageId, input.payloadHash, input.now, null);
    }

    static rehydrate(props: InboxMessageProps): InboxMessage {
        return new InboxMessage(props.consumerName, props.messageId, props.payloadHash, props.receivedAt, props.processedAt);
    }

    get processedAt(): Date | null {
        return this._processedAt;
    }

    isProcessed(): boolean {
        return this._processedAt !== null;
    }

    markProcessed(now: Date): void {
        if (this.isProcessed()) {
            throw new Error(`inbox message ${this.consumerName}/${this.messageId} is already processed`);
        }
        this._processedAt = now;
    }
}

// The same messageId came back with different content: the provider reused an id. A retry cannot help.
export class InboxPayloadMismatchError extends Error {
    constructor(public readonly consumerName: string, public readonly messageId: string) {
        super(`Message ${messageId} was already received by ${consumerName} with a different payload`);
        this.name = "InboxPayloadMismatchError";
        Object.setPrototypeOf(this, InboxPayloadMismatchError.prototype);
    }
}

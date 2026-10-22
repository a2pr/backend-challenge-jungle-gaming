import {BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap} from "@nestjs/common";
import {
    ChangeMessageVisibilityCommand, DeleteMessageCommand, Message, ReceiveMessageCommand, SendMessageCommand, SQSClient,
} from "@aws-sdk/client-sqs";
import {SubmitWagerCommand, SubmitWagerTransactionUseCase} from "../wager/SubmitWagerTransaction.usecase.js";
import {payloadHash} from "../wager/payloadHash.js";
import {SQS_CLIENT} from "./sqs.provider.js";
import {MESSAGING_CONFIG, type MessagingConfig} from "./messaging.config.js";
import {toCommand, wagerMessageSchema} from "./messageSchema.js";
import {classify} from "./errorClassification.js";
import {MetricsService} from "../observability/metrics.service.js";
import {errorType, logEvent} from "../observability/logEvent.js";

export const CONSUMER_NAME = 'wager-consumer';
const LONG_POLL_SECONDS = 20;
const ERROR_PAUSE_MS = 1000;

// Every rule about when a message may leave the queue lives here: after the commit, never before; DLQ before delete;
// a FAILED row on the last receive. No financial logic: it calls the same use case as HTTP.
@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly logger = new Logger(WagerConsumer.name);
    private readonly abort = new AbortController();
    private stopping = false;
    private loop?: Promise<void>;
    private inFlight?: Promise<void>;

    constructor(
        private readonly useCase: SubmitWagerTransactionUseCase,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
        @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
        private readonly metrics: MetricsService,
    ) {
    }

    onApplicationBootstrap(): void {
        if (this.config.workersEnabled) this.loop = this.run();
    }

    // Before (not on) application shutdown: the ORM closes in onApplicationShutdown, and the message in hand still needs it to commit.
    async beforeApplicationShutdown(): Promise<void> {
        this.stopping = true;
        this.abort.abort();             // ends the pending long poll; the message being handled is never aborted
        await this.inFlight;            // it commits and is deleted; unstarted ones were handed back by poll()
        await this.loop;
    }

    // The long poll is the pause between rounds. On an unexpected error, a short fixed pause so a dead database does not spin the CPU.
    private async run(): Promise<void> {
        while (!this.stopping) {
            try {
                await this.pollOnce();
            } catch (error) {
                logEvent(this.logger, 'consumer.poll_failed', {errorType: errorType(error)}, 'error');
                await new Promise((resolve) => setTimeout(resolve, ERROR_PAUSE_MS));   // ponytail: delays shutdown by up to 1 s
            }
        }
    }

    // Tests pass a short wait so an empty queue does not hold them for 20 s.
    async pollOnce(waitSeconds = LONG_POLL_SECONDS): Promise<void> {
        if (this.stopping) return;
        this.inFlight = this.poll(waitSeconds);
        try {
            await this.inFlight;
        } finally {
            this.inFlight = undefined;
        }
    }

    private async poll(waitSeconds: number): Promise<void> {
        let messages: Message[];
        try {
            const received = await this.sqs.send(new ReceiveMessageCommand({
                QueueUrl: this.config.wagerQueueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: waitSeconds,
                MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            }), {abortSignal: this.abort.signal});
            messages = received.Messages ?? [];
        } catch (error) {
            if (this.stopping) return;      // the abort we asked for
            throw error;
        }

        // Sequential: FIFO groups are ordered by the broker and a batch is mostly one wallet's messages.
        // Anything not acked (retry, DLQ trouble) or a shutdown hands back the unstarted rest at once, so a later message
        // of the same group is never handled ahead of the one that stays.
        for (const [index, message] of messages.entries()) {
            if (this.stopping || !(await this.handle(message))) {
                await Promise.all(messages.slice(this.stopping ? index : index + 1).map((m) => this.release(m)));
                return;
            }
        }
    }

    // True when the message left the queue (acked or dead-lettered).
    private async handle(message: Message): Promise<boolean> {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        let command: SubmitWagerCommand | undefined;
        try {
            const parsed = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
            command = toCommand(parsed);
            // Business rejections and 'duplicate-message' return normally and commit: they are acked, never dead-lettered.
            // The SQS message id is the correlation id: stable across redeliveries, so every attempt of one message shares it in the logs.
            await this.useCase.execute(command, {
                correlationId: message.MessageId,
                inbox: {consumerName: CONSUMER_NAME, messageId: parsed.messageId, payloadHash: payloadHash(command)},
            });
        } catch (error) {
            return this.onError(message, command, error, receiveCount);
        }
        // Only after the use case returned (the commit). A failure here leaves the message to come back; the inbox dedupes it.
        return this.remove(message);
    }

    private async onError(message: Message, command: SubmitWagerCommand | undefined, error: unknown, receiveCount: number): Promise<boolean> {
        if (classify(error) === 'permanent') {
            logEvent(this.logger, 'consumer.permanent_failure', {...this.ids(message, command), errorType: errorType(error)}, 'warn');
            return this.deadLetter(message, error, receiveCount);
        }
        // >=, never ===: ApproximateReceiveCount is approximate.
        if (receiveCount < this.config.wagerMaxReceiveCount) {
            this.metrics.retries.inc({source: 'consumer'});
            logEvent(this.logger, 'consumer.retry', {...this.ids(message, command), errorType: errorType(error)}, 'warn');
            return false;
        }
        // D8, last receive: audit row first. If it cannot be stored (database down) the message stays and SQS moves it to
        // the DLQ itself once the receive count is exceeded; the only loss is the audit row.
        try {
            if (command) await this.useCase.recordFailure(command);
        } catch (recordError) {
            logEvent(this.logger, 'consumer.record_failure_failed', {...this.ids(message, command), errorType: errorType(recordError)}, 'error');
            return false;
        }
        return this.deadLetter(message, error, receiveCount);
    }

    // DLQ send, then delete. A crash in between leaves a duplicate in the DLQ (at-least-once); the reverse order would lose it.
    // The SQS MessageId (stable across redeliveries) is the dedup id, so a repeated send inside 5 minutes is dropped.
    private async deadLetter(message: Message, error: unknown, receiveCount: number): Promise<boolean> {
        try {
            await this.sqs.send(new SendMessageCommand({
                QueueUrl: this.config.wagerDlqUrl,
                MessageBody: message.Body ?? '',
                MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
                MessageDeduplicationId: message.MessageId,
                MessageAttributes: {
                    errorType: {DataType: 'String', StringValue: error instanceof Error ? error.name : 'NonError'},
                    errorMessage: {DataType: 'String', StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 1000) || 'empty'},
                    receiveCount: {DataType: 'Number', StringValue: String(receiveCount)},
                },
            }));
        } catch (sendError) {
            logEvent(this.logger, 'consumer.dlq_send_failed', {messageId: message.MessageId, errorType: errorType(sendError)}, 'error');
            return false;
        }
        this.metrics.dlq.inc();
        logEvent(this.logger, 'consumer.dead_lettered', {messageId: message.MessageId, correlationId: message.MessageId, errorType: errorType(error)}, 'warn');
        return this.remove(message);
    }

    // Only ids reach the logs (logEvent allow-list); the body, amounts included, never does.
    private ids(message: Message, command?: SubmitWagerCommand) {
        return {messageId: message.MessageId, correlationId: message.MessageId, walletId: command?.walletId, providerId: command?.providerId};
    }

    private async remove(message: Message): Promise<boolean> {
        try {
            await this.sqs.send(new DeleteMessageCommand({QueueUrl: this.config.wagerQueueUrl, ReceiptHandle: message.ReceiptHandle}));
            return true;
        } catch (error) {
            logEvent(this.logger, 'consumer.delete_failed', {messageId: message.MessageId, errorType: errorType(error)}, 'error');
            return false;
        }
    }

    // Best effort: if it fails the message simply waits out its visibility timeout.
    private async release(message: Message): Promise<void> {
        try {
            await this.sqs.send(new ChangeMessageVisibilityCommand({
                QueueUrl: this.config.wagerQueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0,
            }));
        } catch (error) {
            logEvent(this.logger, 'consumer.release_failed', {messageId: message.MessageId, errorType: errorType(error)}, 'warn');
        }
    }
}

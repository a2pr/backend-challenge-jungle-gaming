import {BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap} from "@nestjs/common";
import {MikroORM} from "@mikro-orm/postgresql";
import {SendMessageCommand, SQSClient} from "@aws-sdk/client-sqs";
import {OutboxRepository} from "./outbox.repository.js";
import {SQS_CLIENT} from "./sqs.provider.js";
import {MESSAGING_CONFIG, type MessagingConfig} from "./messaging.config.js";
import {MetricsService} from "../observability/metrics.service.js";
import {errorType, logEvent} from "../observability/logEvent.js";

const BATCH_SIZE = 50;

// The only place events leave the system: claim, send, mark, commit, in that order. Never called from a use case.
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly logger = new Logger(OutboxPublisher.name);
    private timer?: NodeJS.Timeout;
    private inFlight?: Promise<unknown>;

    constructor(
        private readonly orm: MikroORM,
        private readonly outbox: OutboxRepository,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
        @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
        // Defaulted so tests that build the publisher by hand keep working; Nest injects the shared one.
        private readonly metrics: MetricsService = new MetricsService(),
    ) {
    }

    onApplicationBootstrap(): void {
        if (!this.config.workersEnabled) return;
        this.timer = setInterval(() => this.run(), this.config.outboxPollMs);
    }

    // Before (not on) shutdown: the ORM closes in onApplicationShutdown, and a tick in flight still needs it to commit.
    async beforeApplicationShutdown(): Promise<void> {
        clearInterval(this.timer);
        await this.inFlight;
    }

    // Skips the beat when the previous tick is still running, so ticks never overlap inside one process.
    private run(): void {
        if (this.inFlight) return;
        this.inFlight = this.tick()
            .catch((error) => logEvent(this.logger, 'outbox.tick_failed', {errorType: errorType(error)}, 'error'))
            .finally(() => { this.inFlight = undefined; });
    }

    // One transaction: the row locks from claimDue live until commit, so a second publisher skips these rows.
    // A crash after SendMessage and before commit re-sends the row on the next tick (at-least-once; consumers dedupe by eventId).
    // ponytail: SendMessage runs while row locks are held; claim-then-publish with a lease column if SQS latency hurts.
    async tick(now: Date = new Date()): Promise<{ published: number; failed: number }> {
        let published = 0;
        let failed = 0;
        await this.orm.em.fork().transactional(async (em) => {
            for (const message of await this.outbox.claimDue(em, now, BATCH_SIZE)) {
                try {
                    await this.sqs.send(new SendMessageCommand({
                        QueueUrl: this.config.eventsQueueUrl,
                        MessageBody: JSON.stringify(message.payload),
                        MessageAttributes: {
                            eventId: {DataType: 'String', StringValue: message.id},
                            eventType: {DataType: 'String', StringValue: message.eventType},
                        },
                    }));
                    message.markPublished(now);
                    published++;
                } catch (error) {
                    this.metrics.retries.inc({source: 'outbox'});
                    logEvent(this.logger, 'outbox.publish_failed', {messageId: message.id, errorType: errorType(error)}, 'warn');
                    message.scheduleRetry(now);   // one bad send must not block the rest of the batch
                    failed++;
                }
                await this.outbox.save(em, message);
            }
        });
        return {published, failed};
    }
}

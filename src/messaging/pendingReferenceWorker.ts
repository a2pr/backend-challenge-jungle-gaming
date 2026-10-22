import {BeforeApplicationShutdown, Inject, Injectable, Logger, OnApplicationBootstrap} from "@nestjs/common";
import {MikroORM} from "@mikro-orm/postgresql";
import {SubmitWagerTransactionUseCase} from "../wager/SubmitWagerTransaction.usecase.js";
import {WagerTransactionRepository} from "../wager/wagerTransaction.repository.js";
import {MESSAGING_CONFIG, type MessagingConfig} from "./messaging.config.js";

const BATCH_SIZE = 50;

// Comes back for reversals that arrived before their reference (D3 timeline). Same timer rules as the outbox publisher.
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly logger = new Logger(PendingReferenceWorker.name);
    private timer?: NodeJS.Timeout;
    private inFlight?: Promise<unknown>;

    constructor(
        private readonly orm: MikroORM,
        private readonly wagerRepo: WagerTransactionRepository,
        private readonly useCase: SubmitWagerTransactionUseCase,
        @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
    ) {
    }

    onApplicationBootstrap(): void {
        if (!this.config.workersEnabled) return;
        this.timer = setInterval(() => this.run(), this.config.pendingPollMs);
    }

    async beforeApplicationShutdown(): Promise<void> {
        clearInterval(this.timer);
        await this.inFlight;
    }

    // Skips the beat when the previous tick is still running, so ticks never overlap inside one process.
    private run(): void {
        if (this.inFlight) return;
        this.inFlight = this.tick()
            .catch((error) => this.logger.error(`pending-reference tick failed: ${error}`))
            .finally(() => { this.inFlight = undefined; });
    }

    // Ids only in a short claim transaction; each reprocess then takes the wallet lock in its own transaction (lock order:
    // wallet first). Two workers may pick the same id; the second reprocess sees a terminal state and does nothing.
    async tick(now: Date = new Date()): Promise<{ reprocessed: number; failed: number }> {
        const ids = await this.orm.em.fork().transactional((em) => this.wagerRepo.findDuePendingReference(em, now, BATCH_SIZE));
        let reprocessed = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                await this.useCase.reprocess(id, now);
                reprocessed++;
            } catch (error) {
                this.logger.warn(`reprocess of ${id} failed: ${error}`);    // one bad row must not block the rest
                failed++;
            }
        }
        return {reprocessed, failed};
    }
}

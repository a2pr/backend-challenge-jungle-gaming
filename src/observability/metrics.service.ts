import {Injectable, Optional} from "@nestjs/common";
import {MikroORM} from "@mikro-orm/postgresql";
import {Counter, Gauge, Histogram, Registry} from "prom-client";
import {INSTANCE_ID} from "./instance.js";

// Labels are status, kind, failure code and source only: never a wallet or transaction id (cardinality).
// One registry per instance of this class, not prom-client's global one, so tests that build several never clash.
@Injectable()
export class MetricsService {
    // `instance_id` on every series: a scrape of several instances stays attributable. Not `instance`, which Prometheus adds itself.
    private readonly registry = new Registry();

    readonly transactions = new Counter({
        name: 'wager_transactions_total', help: 'Transactions by the status they reached (a pending one counts again when it resolves)',
        labelNames: ['status', 'kind', 'failure_code'] as const, registers: [this.registry],
    });
    readonly duplicates = new Counter({
        name: 'wager_duplicates_total', help: 'Idempotent replays, duplicate messages and repeated external ids', registers: [this.registry],
    });
    readonly retries = new Counter({
        name: 'wager_retries_total', help: 'Work that will be attempted again', labelNames: ['source'] as const, registers: [this.registry],
    });
    readonly dlq = new Counter({
        name: 'wager_dlq_total', help: 'Messages moved to the dead-letter queue by the consumer', registers: [this.registry],
    });
    readonly reconciliationMismatch = new Counter({
        name: 'wallet_reconciliation_mismatch_total', help: 'Reconciliations where stored balance and ledger differ', registers: [this.registry],
    });
    // Time spent in the wallet FOR UPDATE only. A wait here is what a lock conflict looks like; lock_timeout is 5 s, hence the top bucket.
    readonly lockWait = new Histogram({
        name: 'wallet_lock_wait_seconds', help: 'Time waiting for the wallet row lock',
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5], registers: [this.registry],
    });
    readonly processing = new Histogram({
        name: 'wager_processing_seconds', help: 'Time of one SubmitWagerTransaction.execute, retries included',
        buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [this.registry],
    });

    // Without an ORM (unit tests that build the services by hand) there is simply no lag gauge.
    constructor(@Optional() orm?: MikroORM) {
        this.registry.setDefaultLabels({instance_id: INSTANCE_ID});
        // A labelled counter has no series until its first inc(); starting the known sources at 0 lets rate() see the first retry.
        for (const source of ['consumer', 'outbox', 'pending_reference']) this.retries.inc({source}, 0);
        if (!orm) return;
        // Computed on scrape: a stuck publisher cannot update its own gauge, but the old row is still there to be seen.
        new Gauge({
            name: 'outbox_lag_seconds', help: 'Age of the oldest unpublished outbox row (0 when empty)', registers: [this.registry],
            async collect() {
                try {
                    const rows = await orm.em.getConnection().execute<{ lag: number }[]>(
                        `SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float8 AS lag FROM outbox_messages WHERE published_at IS NULL`);
                    this.set(Number(rows[0].lag));
                } catch {
                    this.set(NaN);   // database unreachable: no data, and the scrape itself must not fail
                }
            },
        });
    }

    readonly contentType = this.registry.contentType;
    render(): Promise<string> {
        return this.registry.metrics();
    }
}

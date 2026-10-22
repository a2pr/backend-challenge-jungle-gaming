import {randomUUID} from 'node:crypto';
import {INestApplication} from '@nestjs/common';
import {MikroORM} from '@mikro-orm/postgresql';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestApp} from '../support/app.js';
import {resetSchema, truncateAll} from '../support/db.js';
import {openWallet} from '../support/fixtures.js';

let app: INestApplication;
let http: Awaited<ReturnType<typeof createTestApp>>['http'];
let orm: MikroORM;

beforeAll(async () => {
    ({app, http} = await createTestApp());
    orm = app.get(MikroORM);
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => app.close());
beforeEach(() => truncateAll(orm));

const scrape = async () => (await http.get('/metrics').expect(200)).text;
// value of one sample line, e.g. sample(text, 'wager_transactions_total{status="PROCESSED",kind="BET",failure_code="none"}')
const sample = (text: string, series: string) => Number(text.match(new RegExp(`^${series.replace(/[{}"]/g, '\\$&')} (\\S+)$`, 'm'))?.[1] ?? 0);
const bet = (w: { walletId: string; playerId: string }, key = randomUUID()) =>
    http.post('/wagering/transactions').set('Idempotency-Key', key).send({
        providerId: 'prov-1', externalTransactionId: `ext-${key}`, playerId: w.playerId, walletId: w.walletId, roundId: 'r', gameId: 'g',
        kind: 'BET', money: {amount: '60.00', currency: 'BRL'},
    });

describe('GET /metrics', () => {
    it('is public and exposes every required metric name', async () => {
        const text = await scrape();

        for (const name of ['wager_transactions_total', 'wager_duplicates_total', 'wager_retries_total', 'wager_dlq_total',
            'wallet_reconciliation_mismatch_total', 'wallet_lock_wait_seconds', 'wager_processing_seconds', 'outbox_lag_seconds']) {
            expect(text, name).toContain(`# TYPE ${name} `);
        }
    });

    it('one processed, one rejected and one replayed transaction move the matching counters', async () => {
        const w = await openWallet(orm, '100.00');
        const before = await scrape();
        const processed = 'wager_transactions_total{status="PROCESSED",kind="BET",failure_code="none"}';
        const rejected = 'wager_transactions_total{status="REJECTED",kind="BET",failure_code="INSUFFICIENT_FUNDS"}';

        const key = randomUUID();
        await bet(w, key).expect(200);          // 100.00 -> 40.00
        await bet(w).expect(422);               // 60.00 > 40.00
        await bet(w, key).expect(200);          // same key: replay, not a new transaction
        const after = await scrape();

        expect(sample(after, processed) - sample(before, processed)).toBe(1);
        expect(sample(after, rejected) - sample(before, rejected)).toBe(1);
        expect(sample(after, 'wager_duplicates_total') - sample(before, 'wager_duplicates_total')).toBe(1);
        // three requests timed, and each took the wallet lock once
        expect(sample(after, 'wager_processing_seconds_count') - sample(before, 'wager_processing_seconds_count')).toBe(3);
        expect(sample(after, 'wallet_lock_wait_seconds_count') - sample(before, 'wallet_lock_wait_seconds_count')).toBe(3);
    });

    it('outbox_lag_seconds grows while rows are unpublished and is 0 when there are none', async () => {
        expect(sample(await scrape(), 'outbox_lag_seconds')).toBe(0);
        const w = await openWallet(orm, '100.00');
        await bet(w).expect(200);                // workers are off in the e2e config: the event row stays unpublished
        await new Promise((resolve) => setTimeout(resolve, 1100));

        expect(sample(await scrape(), 'outbox_lag_seconds')).toBeGreaterThan(1);
    });
});

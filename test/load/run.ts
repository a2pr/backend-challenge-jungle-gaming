// bun run test:load  -- load test of POST /wagering/transactions against a RUNNING app (default: the Compose one on :3000).
// It writes real wallets and transactions into that app's database: use a throwaway stack (`docker compose down -v` resets it).
// Prints a markdown report; the figures and the method are recorded in documentation/load-test.md.
import autocannon from 'autocannon';
import {randomUUID} from 'node:crypto';

const BASE = process.env.LOAD_URL ?? 'http://localhost:3000';
const DURATION = Number(process.env.LOAD_DURATION ?? 15);          // seconds per scenario
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 50);    // concurrent requests
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const DRAIN_MAX = Number(process.env.LOAD_DRAIN_MAX ?? 600);         // seconds to wait for the outbox to empty after each scenario
const RUN = randomUUID().slice(0, 8);                              // keeps keys unique across runs on the same database

const json = {'content-type': 'application/json'};

async function createWallet() {
    const res = await fetch(`${BASE}/wallets`, {
        method: 'POST', headers: json,
        body: JSON.stringify({playerId: randomUUID(), initialBalance: {amount: '1000000.00', currency: 'BRL'}}),   // never runs dry: every BET is accepted
    });
    if (res.status !== 201) throw new Error(`cannot create wallet: ${res.status} ${await res.text()}`);
    const wallet = await res.json() as { id: string; playerId: string };
    return {walletId: wallet.id, playerId: wallet.playerId};
}

// ---- /metrics: counters and histograms are cumulative, so a scenario is the difference of two scrapes ----
type Samples = Map<string, number>;
async function scrape(): Promise<Samples> {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    const out: Samples = new Map();
    for (const line of text.split('\n')) {
        const m = line.match(/^([a-z_]+)(\{[^}]*\})? (\S+)$/);
        if (!m) continue;
        const labels = (m[2] ?? '').replace(/,?instance_id="[^"]*"/, '').replace('{}', '');   // one instance is scraped; drop the label
        out.set(m[1] + labels, (out.get(m[1] + labels) ?? 0) + Number(m[3]));
    }
    return out;
}
const delta = (a: Samples, b: Samples, key: string) => (b.get(key) ?? 0) - (a.get(key) ?? 0);
// Upper bound of the bucket holding the q-quantile of the observations made between two scrapes.
function histogramQuantile(a: Samples, b: Samples, name: string, q: number): string {
    const total = delta(a, b, `${name}_count`);
    if (total === 0) return '-';
    const buckets = [...b.keys()].filter((k) => k.startsWith(`${name}_bucket{le="`) && !k.includes('+Inf'))
        .map((k) => ({le: Number(k.match(/le="([^"]+)"/)![1]), n: delta(a, b, k)})).sort((x, y) => x.le - y.le);
    const hit = buckets.find((bucket) => bucket.n >= q * total);
    return hit ? `<= ${hit.le * 1000} ms` : `> ${buckets.at(-1)!.le * 1000} ms`;
}
const outboxLag = async () => (await scrape()).get('outbox_lag_seconds') ?? 0;

const percentile = (sorted: number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : NaN;

async function scenario(name: string, walletCount: number) {
    const wallets = await Promise.all(Array.from({length: walletCount}, createWallet));
    let n = 0;
    const times: number[] = [];
    const options = (duration: number): autocannon.Options => ({
        url: BASE, connections: CONNECTIONS, duration,
        requests: [{
            method: 'POST', path: '/wagering/transactions',
            setupRequest: (req) => {                       // fresh key and external id per request: nothing is a replay
                const id = `${RUN}-${name}-${n++}`;
                const w = wallets[n % wallets.length];
                return {
                    ...req, headers: {...json, 'idempotency-key': `load-${id}`},
                    body: JSON.stringify({providerId: 'load', externalTransactionId: `ext-${id}`, playerId: w.playerId, walletId: w.walletId,
                        roundId: 'r', gameId: 'g', kind: 'BET', money: {amount: '1.00', currency: 'BRL'}}),
                };
            },
        }],
    });

    await autocannon(options(2));                          // warm-up: JIT, pool and caches; discarded
    const before = await scrape();
    let maxLag = 0;
    const lagTimer = setInterval(async () => { maxLag = Math.max(maxLag, await outboxLag().catch(() => 0)); }, 500);
    const result = await new Promise<autocannon.Result>((resolve, reject) => {   // callback form: it returns the instance, which emits every response time
        const run = autocannon(options(DURATION), (error, res) => error ? reject(error) : resolve(res));
        run.on('response', (_client: unknown, _status: number, _bytes: number, ms: number) => { times.push(ms); });
    });
    clearInterval(lagTimer);

    const drainStart = Date.now();                         // how long the publisher needs to empty the outbox after the load stops
    while (await outboxLag() > 0 && Date.now() - drainStart < DRAIN_MAX * 1000) await new Promise((r) => setTimeout(r, 500));
    const drainSeconds = (Date.now() - drainStart) / 1000;
    const after = await scrape();

    times.sort((x, y) => x - y);
    const total = result.requests.total;
    const ok = result['2xx'];
    return {
        name, wallets: walletCount, total, throughput: Math.round(total / DURATION), ok,
        errorRate: total ? ((total - ok) / total * 100).toFixed(2) : '0',
        statuses: JSON.stringify(result.statusCodeStats && Object.fromEntries(Object.entries(result.statusCodeStats).map(([k, v]) => [k, v.count]))),
        p50: percentile(times, 0.5), p95: percentile(times, 0.95), p99: percentile(times, 0.99), max: times.at(-1),
        lockP50: histogramQuantile(before, after, 'wallet_lock_wait_seconds', 0.5),
        lockP95: histogramQuantile(before, after, 'wallet_lock_wait_seconds', 0.95),
        lockP99: histogramQuantile(before, after, 'wallet_lock_wait_seconds', 0.99),
        procP95: histogramQuantile(before, after, 'wager_processing_seconds', 0.95),
        duplicates: delta(before, after, 'wager_duplicates_total'),
        maxLag: maxLag.toFixed(1), drainSeconds: drainSeconds.toFixed(1),
    };
}

const results = [await scenario('hot-wallet', 1), await scenario('many-wallets', WALLETS)];

console.log(`\n## Load test ${new Date().toISOString()}\n`);
console.log(`Target ${BASE}, ${CONNECTIONS} connections, ${DURATION} s per scenario (plus 2 s warm-up), BET 1.00 on wallets funded with 1000000.00.\n`);
console.log('| scenario | wallets | requests | req/s | 2xx | error rate % | HTTP statuses | latency p50 / p95 / p99 / max (ms) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.wallets} | ${r.total} | ${r.throughput} | ${r.ok} | ${r.errorRate} | ${r.statuses} | ${r.p50} / ${r.p95} / ${r.p99} / ${r.max} |`);
console.log('\n| scenario | lock wait p50 | lock wait p95 | lock wait p99 | processing p95 | duplicates | max outbox lag (s) | seconds to drain outbox |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.lockP50} | ${r.lockP95} | ${r.lockP99} | ${r.procP95} | ${r.duplicates} | ${r.maxLag} | ${r.drainSeconds} |`);

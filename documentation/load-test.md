# Load test

`bun run test:load` (`test/load/run.ts`, autocannon). One experiment, one machine, one run per configuration: the figures are relative and not a benchmark. The README sets no RPS target; what the test is for is to find where the system bends and whether it stays correct while it does.

## Environment

| | |
|---|---|
| Host | Intel i5-10300H (4 cores, 8 threads), 31 GB RAM, Linux 5.15, Docker 29.9.1 |
| App | the Compose `nest-app` container: Node 22.22 (the runtime before D19 moved the app to bun; not re-run since), one process, `bun run start:dev` (dev mode, source bind-mounted), `DATABASE_POOL_MAX=20`, workers on (consumer, outbox publisher at 1 s, pending-reference worker) |
| Database | `postgres:13` in Docker on the same host, default settings |
| Queues | LocalStack 4.4 in Docker on the same host |
| Load generator | autocannon on the same host: it competes with the app, the database and LocalStack for the same 8 threads |
| Date | 2026-10-22, from a freshly created database (`docker compose down -v`, `up`, `migration:up`) |

## Method

- `POST /wagering/transactions`, `BET` of 1.00 BRL. Wallets are created through the API with 1,000,000.00, so no request is ever rejected for funds: this measures the happy path.
- Every request has its own `Idempotency-Key` and `externalTransactionId`, so nothing is a replay.
- Two scenarios, each 2 s of warm-up (discarded) then 15 s measured, 50 concurrent connections (second run: 10):
  - **hot-wallet**: all requests on one wallet.
  - **many-wallets**: requests spread round-robin over 200 wallets.
- Latency percentiles are exact, from the response time of every request (autocannon `response` events). Lock wait and processing time are read from the app's own `/metrics` (difference of two scrapes); the histogram only gives the upper bound of a bucket, hence "<=".
- Outbox lag is sampled every 500 ms during the load; after the load the script waits until the lag is 0 and reports how long that took (cap 600 s).
- Between scenarios the outbox is empty (the script waits for the drain), so one scenario does not inherit the previous one's backlog. A first run without that wait was discarded for that reason.
- After the runs: 24,483 `PROCESSED` transactions, 402 wallets, `wallet.balance = SUM(ledger)` on every wallet (0 mismatches), 48,966 outbox rows, all published.

## Results

50 connections:

| scenario | wallets | requests | req/s | error rate | latency p50 / p95 / p99 / max (ms) |
|---|---|---|---|---|---|
| hot-wallet | 1 | 3,574 | 238 | 0% (all 200) | 197 / 291 / 334 / 394 |
| many-wallets | 200 | 7,030 | 469 | 0% (all 200) | 107 / 120 / 132 / 291 |

| scenario | lock wait p50 / p95 / p99 | processing p95 | duplicates | seconds to drain the outbox |
|---|---|---|---|---|
| hot-wallet | <= 100 / 500 / 500 ms | <= 500 ms | 0 | 143 |
| many-wallets | <= 5 / 10 / 10 ms | <= 250 ms | 0 | 313 |

10 connections:

| scenario | wallets | requests | req/s | error rate | latency p50 / p95 / p99 / max (ms) |
|---|---|---|---|---|---|
| hot-wallet | 1 | 4,025 | 268 | 0% | 37 / 65 / 82 / 115 |
| many-wallets | 200 | 6,586 | 439 | 0% | 22 / 29 / 34 / 62 |

| scenario | lock wait p50 / p95 / p99 | processing p95 | duplicates | seconds to drain the outbox |
|---|---|---|---|---|
| hot-wallet | <= 50 / 100 / 100 ms | <= 100 ms | 0 | 165 |
| many-wallets | <= 5 / 5 / 5 ms | <= 50 ms | 0 | 291 |

## What the figures show

1. **Correctness held under load.** No errors, no `lock_timeout` (no 503), no duplicate, every balance equals its ledger. Nothing in this test could make a wallet negative (balances never ran low); that case is covered by the race tests (`concurrency.spec.ts`, `multi/http.spec.ts`).
2. **A hot wallet is serialised, many wallets are not.** One wallet gives about 240 to 270 req/s whatever the connection count; spread over 200 wallets, about 440 to 470. This matches the D1 experiment (225 versus 550 bets/s) and the design: the row lock is the unit of concurrency.
3. **More connections only add waiting.** On the hot wallet, 50 connections instead of 10 gave no extra throughput (238 versus 268) but p50 went from 37 to 197 ms and the lock-wait p95 from <= 100 ms to <= 500 ms: by Little's law latency is about connections divided by throughput, and the extra requests queue in Postgres on the wallet lock. This is why `lock_timeout` is 5 s and the pool is capped.
4. **For many wallets the lock is not the limit.** Lock wait stays at <= 10 ms; the ceiling of about 450 req/s is the single Node process, the database and the load generator sharing the same machine. Not measured: more instances (`test:multi` proves their correctness, not their throughput).
5. **The outbox publisher is the bottleneck of the system, and it is a ceiling, not a bug.** It publishes at most one batch of 50 per 1 s tick, so about 50 events/s (measured: 48,966 events in 982 s, 50/s). A `BET` writes two events, so the sustainable rate is about 25 transactions per second; the test drove 240 to 470. Transactions stayed fast and correct, but events fall behind and the backlog drains only after the load stops (143 to 313 s for 15 s of load). The "max outbox lag" the script samples during the 15 s window is therefore always about 15 s; the drain time is the honest figure. `outbox_lag_seconds` is the metric that would page someone. Ways up, by cost: run the next batch at once while batches come back full; `SendMessageBatch` (10 messages per call instead of one call per row); a shorter poll interval; more instances (`SKIP LOCKED` divides the rows, so three instances triple the 50/s).

## Limits of this test

- One machine and one run per configuration: no variance, no confidence interval.
- The app runs in the dev container (`nest start --watch`), not a production build, and shares the CPU with the load generator, Postgres and LocalStack.
- Only the happy path: no insufficient funds, no replays, no references, no queue consumer load (the HTTP path only), one app instance.
- Server-side quantiles are histogram bucket bounds, not exact values.

## Reproduce

```bash
docker compose down -v && docker compose up -d --build
docker compose exec nest-app bun run migration:up
bun run test:load                           # LOAD_CONNECTIONS=10 LOAD_DURATION=15 LOAD_WALLETS=200 LOAD_DRAIN_MAX=600 LOAD_URL=http://localhost:3000
```

It writes real data into the target's database; `down -v` resets it.

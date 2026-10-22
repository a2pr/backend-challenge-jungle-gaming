# Tests

Three vitest configs (unit, integration/e2e, multi-instance), one database. `bun` must be on PATH; if it is not, prefix the commands with `bunx` as below.

| Command | What runs | Needs |
|---|---|---|
| `bun run test` | unit specs: `src/**/*.spec.ts`, `test/unit/**` (domain, events, errors, domain purity) | nothing |
| `bun run test:e2e` | `test/integration/**` and `test/e2e/**` against real Postgres and LocalStack | `docker compose up -d db localstack` (wait until LocalStack is `healthy`) and `DATABASE_URL_TEST`, `AWS_*` and the queue URLs in `.env` (see `.env.example`) |
| `bun run test:multi` | `test/integration/multi/**`: 3 real `node dist/main.js` processes sharing one database and one queue (HTTP race, consumers, publishers, `SIGKILL` restart, `SIGTERM`); builds `dist/` first if it is stale | `docker compose up -d db localstack` only, see "Multi-instance tests" below |
| `bunx vitest run --config ./vitest.config.experiments.ts` | `test/experiments/**`: the contention experiment (D1), prints a markdown table; **not** part of the suite | same as e2e |
| `bunx tsc --noEmit`, `bunx oxlint src/ test/`, `bun run build` | types, lint, compile | nothing |

## The integration suite

- `DATABASE_URL_TEST` points at a separate database; `test/support/globalSetup.ts` creates it if missing.
- Every integration spec calls `resetSchema` (drops and recreates `public`) and runs the migration in `beforeAll`, then `truncateAll` in `beforeEach`, so each run starts from an empty schema. Files run one after another (`fileParallelism: false`); the parallelism is *inside* the specs.
- Every test that touches a wallet ends with `assertLedgerMatchesBalance` (`test/support/ledger.ts`): wallet balance equals the sum of its ledger.
- Raw SQL in tests and repositories must join the transaction (`em.getTransactionContext()`), see `phases/phase-04-use-cases.md`, step 2.

## `DATABASE_POOL_MAX`

- `vitest.config.e2e.ts` sets `DATABASE_POOL_MAX=60`. The concurrency tests open up to 200 calls at once; with a pool smaller than the parallelism the calls queue inside the driver and the race is not really exercised.
- The pool must stay **below Postgres `max_connections`** (100 by default in `postgres:13`) minus other clients. The contention experiment at pool 200 failed 100 calls with `sorry, too many clients already` (`ARCHITECTURE.md`, "Contention experiment"). A bigger pool does not make one hot wallet faster: the row lock serialises it.

## Determinism

Races are only trustworthy if they pass every time:

```bash
for i in 1 2 3; do bunx vitest run --config ./vitest.config.e2e.ts; done
```

If one run differs, run the failing file alone 20 times (`for i in $(seq 20); do bunx vitest run --config ./vitest.config.e2e.ts test/integration/<file>; done`) to tell a code bug from a test bug. `maxInFlight > 1` in `concurrency.spec.ts` proves the calls overlapped.

## Where the numbered tests live

| Test | File |
|---|---|
| 1, 6, 9b | `test/integration/submitWagerTransaction.spec.ts` |
| 2, 3, 4, 5 | same file, `idempotency` block |
| 6 (references), 7, 7b, 8, 9 | `test/integration/references.spec.ts` |
| 10, 11 | `test/integration/concurrency.spec.ts` |
| 12, 14 | `test/integration/inbox.spec.ts` |
| 13 | `test/integration/createWallet.spec.ts` |
| 15 | `test/experiments/contention.spec.ts` |
| outbox: claim, publisher (rollback, crash, two publishers, retry, timer) | `test/integration/outboxClaim.spec.ts`, `test/integration/outbox.spec.ts` |
| SQS test helpers | `test/integration/sqsSupport.spec.ts` |
| consumer: ack, duplicates, crash after commit, DLQ, `FAILED`, redrive, shutdown, timer loop, `maxReceiveCount` | `test/integration/consumer.spec.ts` (about 35 s: it waits out the 2 s visibility timeout) |
| `recordFailure`, `reprocess`, `findDuePendingReference` | `test/integration/recordFailureReprocess.spec.ts` |
| pending-reference worker: out of order, D3 timeline, concurrent ticks | `test/integration/pendingReference.spec.ts` |
| readiness reads the queue | `test/e2e/health.e2e-spec.ts` |

Current state (2026-10-21): 427 unit, 220 integration and e2e, 8 multi-instance, three green runs in a row of each.

The outbox tests create uniquely named throwaway queues with a 2 s visibility timeout (`test/support/sqs.ts`), never the compose queues, and `vitest.config.e2e.ts` sets `WORKERS_ENABLED=false` so booting the app in a test does not start the publisher timer.

## Multi-instance tests (phase 8)

Proof that the system is correct with several instances and after a crash, not only with one. Eliminatory rule of the README.

```bash
docker compose up -d db localstack     # wait until LocalStack is healthy; the nest-app service is NOT needed
bun run test:multi                     # about 26 s for the whole set
```

**How docker-compose has to be run for this.**
- Only `db` and `localstack` are needed. The test starts the app instances itself as child processes on the host (`node dist/main.js`, ports 3101, 3102, ...), so they use `localhost:5432` and `localhost:4566` from `.env`.
- `nest-app` can stay up or be stopped; it does not interfere: it uses the `nest` database and the compose queues, the tests use `nest_test` and throwaway queues (`test-...-<random>`, 2 s visibility timeout). It only costs CPU while the instances run, so stop it for the cleanest timings: `docker compose stop nest-app`.
- `.env` must define `DATABASE_URL_TEST`, the `AWS_*` variables and the three queue URLs (as for `test:e2e`). `TESTING_MULTIPLE_INSTANCES=3` sets the default number of instances.
- Free host ports 3101 and up (one per instance; a replacement instance takes the next free number, ports are not reused inside a run).
- The children run the compiled `dist/`, which vitest does not transform. `test/support/globalSetupMulti.ts` runs `nest build` when `dist/main.js` is older than anything in `src/`, so a stale build cannot test old code. `bun run build` by hand is not needed.

| Spec | Scenario | Asserts |
|---|---|---|
| `smoke.spec.ts` | 3 instances start, `/health/ready` is 200, `stop()` leaves none | the helper works; the port is closed afterwards |
| `http.spec.ts` | 30 BETs of 10.00 on 100.00, round-robin over the 3 ports at once; 30 requests with one `Idempotency-Key` over the 3 ports | exactly 10 `PROCESSED` and 20 `INSUFFICIENT_FUNDS`, balance 0.00, 10 debits, ledger rebuilds the balance; one debit and 29 replays. The wallet is opened on instance 0 and read on instance 1 |
| `consumer.spec.ts` | 200 messages over 20 wallets on one FIFO queue, 3 consumers; the same key over HTTP and as an SQS message at the same time | 100 `PROCESSED` + 100 `REJECTED`, 200 inbox rows, every balance 0.00, queue and DLQ empty; one effect for the cross-channel key |
| `outbox.spec.ts` | 300 due outbox rows, 3 publishers start on the same backlog | every row `published_at`; the distinct `eventId`s on the events queue equal the rows (duplicates would be fine, losses not) |
| `restart.spec.ts` | 576 business transactions (queue and HTTP) over 12 wallets; `SIGKILL` of instance 0 once 30 rows are stored; a replacement starts; HTTP clients retry the same key on another instance | exit status 137; kill lands before the load ends (12 to 21 messages in flight at the kill in three runs); stored keys equal sent keys, each exactly once; no 5xx reaches the client at the end; every event published |
| `shutdown.spec.ts` | `SIGTERM` to instance 0 while it handles messages | exit status 143 inside 10 s; the rest drains on the other two; same end-state checks as above |

Every scenario ends with `waitForSettled` (`test/support/multi.ts`): stored count equals sent count, no transaction outside `PROCESSED`/`REJECTED`, wager queue and DLQ empty, no unpublished outbox row, `assertLedgerMatchesBalance` on every wallet. Waits poll the database and the queue with a deadline; there is no fixed sleep anywhere.

**When a test fails** the output of every instance is printed (`dumpOutput`), prefixed with its id, so you can see which one did what.

**Exit statuses.** The helper reports shell-style statuses: `SIGTERM` is 143 and `SIGKILL` is 137. The phase document said "exit code 0" for `SIGTERM`; that is not what Nest does: it re-raises the signal after its shutdown hooks (see `ARCHITECTURE.md`, "Known limits"). The exit status alone does not tell a graceful stop from a plain kill, because a process without handlers also ends with 143; what proves the graceful path is the data after the drain (nothing lost or doubled) together with the in-process shutdown test in `consumer.spec.ts` and the real-process check recorded in `progress-log.md`, phase 7.

**The tests can fail.** The HTTP race was checked by removing the wallet lock on a local branch (`lockMode: PESSIMISTIC_WRITE` in `wallet.repository.ts`): both HTTP tests failed (3 `PROCESSED` instead of 10, 503 for the same-key replays). The sabotage was reverted, never committed.

**Limits.**
- `INSTANCE_ID` is passed to each child but the application does not read it, so the tests cannot assert that every instance did a share of the work, only that the combined result is right. Adding the id to the startup log line would allow that.
- The kill and the `SIGTERM` land "after 30 rows", not at a chosen line of code. Messages in flight at that moment make it a real redelivery test, but which message the victim held is not controlled. The assertions hold for any timing.
- Same machine, same Postgres: this shows correctness across processes, not across hosts or network partitions.

Determinism, as for the other suites:

```bash
for i in 1 2 3; do bun run test:multi; done
```

## HTTP tests and Postman (phase 5)

| Spec | What it covers |
|---|---|
| `test/unit/http/toHttp.spec.ts` | the D9 error mapping, `Retry-After`, no message leak |
| `test/unit/http/money.dto.spec.ts`, `submitTransaction.dto.spec.ts` | request shapes |
| `test/unit/http/transactionResponse.spec.ts` | status per outcome, `toStoredBody` |
| `test/unit/http/cursor.spec.ts` | opaque ledger cursor |
| `test/e2e/wallets.e2e-spec.ts` | create and read wallets |
| `test/e2e/wagering.e2e-spec.ts` | submit (outcomes, idempotency, races, bad requests, 503) and the two transaction reads |
| `test/e2e/ledger.e2e-spec.ts` | pagination: 120 entries, an entry between pages, limits, bad cursors |
| `test/e2e/reconciliation.e2e-spec.ts` | consistent, corrupted (signed difference, error log, no repair), 404 |

The Postman collection (`documentation/postman_collection.json` with `documentation/postman_environment.json`) is the list of every request and error case of the API. Run it against `docker compose up` (the app, after `migration:up`):

```bash
npx newman run documentation/postman_collection.json -e documentation/postman_environment.json
```

Each run creates a new player and new external ids, so it can run twice on the same database. It needs the wallet requests first: the Wagering, Reads, Ledger and Reconciliation folders use the `walletId` the Wallets folder stores.

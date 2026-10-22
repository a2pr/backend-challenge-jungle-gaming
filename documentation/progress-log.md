# Progress log

Status against the README (`README.md`, section numbers in brackets). Final status table first, per-phase notes after. Updated 2026-10-22.

## Final status (2026-10-22)

| README area (weight) | State | Where it is shown |
|---|---|---|
| Financial correctness (20) | done: `Money` on decimal.js, append-only ledger, all kinds and reversals, reconciliation endpoint | phases 2 to 5, `ARCHITECTURE.md` |
| Concurrency (20) | done: wallet `FOR UPDATE`, hot-wallet tests, 3 real processes, `SIGKILL` and `SIGTERM` | phases 4 and 8, `test:multi` |
| Idempotency (15) | done: persistent keys, replay, payload conflict, cross-channel | phase 4, `http.spec.ts`, `consumer.spec.ts` |
| Messaging and failures (15) | done: inbox, outbox, retry, DLQ, crash recovery, graceful shutdown | phases 6 and 7 |
| Modelling and architecture (10) | done with a stated cut: invariants in domain classes, no ports (D11) | `ARCHITECTURE.md` |
| Tests (10) | done: unit, real Postgres and SQS integration, races, multi-instance; no load test | `tests.md` |
| Observability (5) | done: JSON logs with allow-list, `/metrics`, health, outbox lag | phase 9 |
| Documentation (5) | done: README setup, `ARCHITECTURE.md`, `tests.md`, `deployment.md`, `taxonomy.md`, Postman | phase 10 |
| Auth (0) | not implemented by design: no-op `AuthGuard` (D15) | `ARCHITECTURE.md` |

Cut or not built (all listed with ceilings in `ARCHITECTURE.md`, "Limitations" and "Considered, not implemented"): load test, repository ports, outbox lease/reaper, inbox/outbox retention, real identity provider, hot-wallet partitioning, per-instance metric label.

## Baseline (phase 0)

| Area | What exists | Where |
|---|---|---|
| Project skeleton | NestJS 12, TypeScript strict, ESM (`nodenext`), vitest, oxlint | `package.json`, `tsconfig.json` |
| Package manager | bun as package manager/script runner; Nest still runs on Node | `bun.lock`, `Dockerfile` |
| Docker Compose | `nest-app` (live reload via bind mount), `db` (postgres:13), `localstack` (SQS only) | `docker-compose.yaml` |
| ORM wiring | MikroORM v7 + `@mikro-orm/nestjs`, explicit entity list | `src/mikro-orm.config.ts` |
| Health checks | `/health/live` always 200; `/health/ready` probes Postgres and the SQS queue, 2 s timeout each | `src/health.*.ts` |

## Decisions taken so far (Money decisions are already in `ARCHITECTURE.md`; the rest are to be copied)

- **LocalStack pinned to 4.4.** `latest` and `-pro` abort at startup without `LOCALSTACK_AUTH_TOKEN`. 4.4 runs with no account, so a reviewer can `docker compose up` cold. Cost: no security patches, older SQS emulation.
- **Container runs as `node` (uid 1000).** With the project bind-mounted, a root container left root-owned `dist/` on the host and broke `bun run build`.
- **Readiness probes use the real clients, not HTTP calls to the containers.** Postgres has no HTTP endpoint, and `/_localstack/health` only exists in LocalStack, so it would pass while the app's own SQS config was broken.
- **MikroORM connects lazily**, so `orm.checkConnection()` reports "not established" until the first query. The probe runs an actual query instead.
- **vitest/coverage pinned to ^5.** `^4` crashes npm's resolver (`edgesOut` error). Irrelevant under bun but kept at 5.

## Phase 2: domain model (done 2026-10-21)

State: `bun run test` 280 passed in 7 files (`money`, `backoff`, `payloadHash`, `wagerTransaction`, `wallet`, `walletLedgerEntry`, `domainPurity`); `bunx tsc --noEmit` clean; `bun run build` ok; `bun run lint` clean. Coverage of the domain folders: 99.33% lines, 95.74% branches (`money.ts` 96.77%, `wagerTransaction.ts` 99.28%, every other file 100%). Note: vitest's text reporter hides files at 100%, so the table looks shorter than the folder; use `--coverage.reporter=json-summary` to see every file.

| Item | State | Detail |
|---|---|---|
| 1-2 Money errors | done | typed `InvalidMoneyError`, `CurrencyMismatchError`; `Money.from` rejects negatives (negative values come from `negate` / `subtract`) |
| 3 `FailureCode` | done | `ReversalAmountMismatch` and `CurrencyMismatch` renamed, values unchanged |
| 4 `InvalidTransactionStateError` | done | in `src/wager/errors.ts` |
| 5 `payloadHash` | done | golden value pinned |
| 6 `backoffMs` | done | policy constants in `wagerTransaction.ts`, pinned by `backoff.spec.ts` |
| 7 `WagerTransaction` | done | `create` rule table (21 amount cases, 8 blank fields), transitions with the 12-case terminal matrix, retry timeline 20 / 60 / 140 s, `ledgerDirectionFor`, `checkReference` with the 6 x 6 kind matrix |
| 8 `WalletLedgerEntry` | done | validation order and `rehydrate` without validation |
| 9 `Wallet` | done | `open`, `rehydrate`, `debit`, `credit`, `openingEntry`; failed movements leave balance, version and `updatedAt` untouched |
| 10 `src/wallet/errors.ts` | done | `InvalidMovementError`, `InsufficientFundsError` |
| Specs | done | all seven files above, including `domainPurity` (no `@nestjs`, `@mikro-orm`, `new Date()`, `Date.now()` or `randomUUID` in `src/money`, `src/wager`, `src/wallet`; adapter suffixes skipped) |

Bugs the new spec found in the first run, now fixed: `create` stored `now` as `processedAt`, and `hasReference()` read the internal id instead of the provider's id.

Optional leftovers, none blocks phase 3: `from` / `to` as fields on `InvalidTransactionStateError` (phase 5 filter may want them); `ROLLBACKABLE` duplicates `ALLOWED_REFERENCE_KINDS[Rollback]`; the commented-out block at the bottom of `wagerTransaction.ts`; `money.ts` line 23 (`amount.lt(0)`) is only reachable with a `-` amount and has no test; the final negative check in `create` (line ~215) is not covered.

Next: Phase 4 (use cases).

## Phase 3: schema and migration (done 2026-10-21)

State: `test/integration` 27 passed (`schema.spec.ts` 21, `mappers.spec.ts` 6) against the real Postgres `nest_test` database; `bun run test` 280 passed; `bun run test:e2e` 29 passed (integration plus the 2 health e2e); `tsc`, `nest build` and `oxlint` clean.

| Item | State | Detail |
|---|---|---|
| Migration | done | `src/migrations/Migration20261021104500_initial.ts`: five tables, partial indexes, append-only trigger, `down()` in reverse order |
| Config | done | `Migrator` extension, migrations path, pool from `DATABASE_POOL_MAX`; entities listed explicitly (see `ARCHITECTURE.md`) |
| Schemas | done | wallet, wager transaction, ledger entry, inbox, outbox |
| Mappers | done | wallet, wager transaction (`extras.balanceAfter`), ledger entry |
| Runner | done | `src/migrate.ts`, `bun run migration:up|down|status` |
| Test support | done | `test/support/db.ts`: `createOrm`, `resetSchema`, `truncateAll` |
| Constraint tests | done | negative balance, duplicate wallet / external id / idempotency key, `REFUND` without and `BET` with a reference, `REJECTED` without a failure code, `PROCESSED` without `processed_at`, amount rules, ledger balance and amount, one ledger row per transaction, ledger `UPDATE` / `DELETE`, one `PROCESSED` reversal per reference (a `REJECTED` second one allowed), `TRUNCATE` still allowed |
| Round trips | done | `0.10` stays `"0.10"`; nullable columns map to `undefined`; `balanceAfter` only written when given |
| Docs | done | `ARCHITECTURE.md` schema notes, `deployment.md` migration section |

Found on the way: the migration had no `down()`; the wager schema had a copy-paste `game_id` mapped to `provider_id`, `money` instead of `amount` and `currency`, `provider_id` typed as uuid, and no nullable columns; the `*.schema.ts` glob broke the e2e boot; `node dist/migrate.js` could not see `.env`, fixed by running the scripts under bun.

Open: `seq` is not mapped yet (phase 5 pagination). `deployment.md` migration commands were run from the host with bun, not yet through `docker compose exec`. No database test covers concurrent writers; that is phase 4 (test 15) and phase 8.

Next: Phase 4 (use cases).

## Phase 4: use cases (done 2026-10-21)

State: `bun run test` 291 passed, `bun run test:e2e` 91 passed (16 repositories, 5 createWallet, 10 submitWagerTransaction, 13 references, 9 inbox, 3 concurrency, schema, mappers, support, 2 health e2e), `tsc`, `nest build` and lint clean.

| Step | State | Detail |
|---|---|---|
| 0 Test support | done | `test/support/ledger.ts` (`assertLedgerMatchesBalance`), `fixtures.ts` (`openWallet`, `betCommand`, `runInParallel`) |
| 1 Errors and events | done | `IntegrationEvent` and the four events with `events.spec.ts`; the three request errors exported with typed fields, `errors.spec.ts` |
| 2 Repositories | done | wallet, wager transaction, ledger, outbox (enqueue), inbox; `test/integration/repositories.spec.ts` 16 tests including the lock actually blocking a second locker and a stale-version `save` |
| 3 `CreateWallet` and modules | done | `CreateWalletUseCase`, `MessagingModule`, `WalletModule`, `@Injectable()` on the repositories; `createWallet.spec.ts` tests 13a to 13d plus a Nest wiring test |
| 4 `SubmitWagerTransaction`, simple kinds | done | `run` (lock, build, wallet checks, apply, events, persist), `apply` free of I/O for the phase 7 reuse; tests 1 (the 80.00 race, three runs), 6 without references, 9b, unknown wallet, blank `roundId` |
| 5 Idempotency | done | key lookup (replay with stored `balanceAfter`, `IdempotencyConflictError`), external id lookup (`DuplicateExternalTransactionError`); tests 2 (50 parallel, 1 original and 49 replays), 3, 3b, 4, 5. Review added the missing null `balanceAfter` guard (`tsc` failed) |
| 6 References and reversals | done | `resolveReference` (pending / rejected / found, `checkReference`, `findReversalOf`) and the branch in `run`; `references.spec.ts`: tests 6, 6b, 7, 7b, 7c, 8, 8b, 9 |
| 7 Inbox and atomicity | done | `run` wraps `process`: `tryInsert` first, `markProcessed` last, same transaction; `execute` returns `SubmitWagerOutcome` (`completed` or `duplicate-message`); tests 12a to 12c, 14a to 14f |
| 8 Concurrency suite | done | `concurrency.spec.ts`: 10a (200 bets, all processed), 10b (100 processed, 100 `INSUFFICIENT_FUNDS`, balance 0.00), 11 (20 wallets x 10 bets); three full runs 91 passed, 14.2 / 13.9 / 12.8 s |
| 9 Contention experiment | done | `test/experiments/contention.spec.ts`; hot wallet 200 to 230 bets/s, spread wallets about 540, no `lock_timeout`; pool 200 fails against Postgres `max_connections` 100 (table in `ARCHITECTURE.md`) |

Bugs found on the way (step 7): `RunInput` lacked `inbox` and `execute` never passed `ctx.inbox` on, so the inbox was dead code (and `tsc` failed). Fixed in review, covered by 14a.

Bugs found on the way (step 6): the first `resolveReference` never returned its computed outcome, so every reversal was applied whatever the reference status (a refund of a rejected bet credited the wallet). Caught in review, fixed, covered by tests 7 and 7b. Lesson: an implicit-`any` local assigned in a `switch` compiles even when nothing reads it.

Bugs found on the way: raw SQL through `em.getConnection().execute(sql, params)` ran outside the transaction (it hung the stale-version test, and would have broken inbox and atomicity silently); fixed by passing `'all', em.getTransactionContext()`. The scaffold caught `DuplicateWalletError` where the ORM throws `UniqueConstraintViolationException`. `domainPurity` treated `wallet.module.ts` as domain code; `module` joined the adapter suffixes.

Decisions (details in `ARCHITECTURE.md`, "Use case wiring"): two modules, no `WagerModule`; unique violation translated after the rollback; wager finders return `balanceAfter`.

Closed: the repository file was renamed to `wagerTransaction.repository.ts`.

Open items for the next phases:

- **Phase 5 (HTTP):** map `WalletNotFoundError` 404, `IdempotencyConflictError` and `DuplicateExternalTransactionError` 409, `InvalidWagerTransactionError` and `InvalidMoneyError` 400, a Postgres `55P03` (lock timeout) to a retryable status; read `result.kind` (`SubmitWagerOutcome`); ledger `page` and reconciliation (reuse `sumByWallet`); decide the cross-wallet same-key retry (unique violation around `em.transactional`, one retry); keep `DATABASE_POOL_MAX` below Postgres `max_connections` (see `tests.md`).
- **Phase 6 (outbox):** `claimDue` with `FOR UPDATE SKIP LOCKED`, publisher, retries.
- **Phase 7 (consumer):** build `ctx.inbox` from the SQS message, ack on `duplicate-message`, `reprocess`, `findDuePendingReference`, end a pending reference as `REFERENCE_NOT_FOUND` after the retry limit (`markPendingReference` throws at the limit, so the worker must call `reject` first), `FAILED` rows and the DLQ.
- **Housekeeping:** `SubmitWagerTransaction.usecase.ts` casing (cosmetic); time per step was not recorded (start in phase 5).

## Phase 5: HTTP API and Postman (done 2026-10-21)

State: `bun run test` 383 passed, `bun run test:e2e` 175 passed (three runs in a row), `tsc`, `nest build` and lint clean. Postman: 34 requests, 67 assertions, green twice on the same database.

| Step | State | Detail |
|---|---|---|
| 0 HTTP test support | done | `test/support/app.ts` (`createTestApp(customize?)`), `zod`, `supertest` |
| 1 Errors to HTTP | done | `toHttp`, `DomainExceptionFilter`, `parse`, `BadRequestError`, `AuthGuard`, `configureApp` (shared by `main.ts` and the tests); `toHttp.spec.ts` |
| 2 Wallet endpoints | done | `POST /wallets` (201), `GET /wallets/:id`; money and create-wallet DTOs; `WalletRepository.findById`; `wallets.e2e-spec.ts` |
| 3 `POST /wagering/transactions` | done | DTO + `toCommand`, `toResponse`, `WageringController`; the cross-wallet same-key race handled by one retry in `execute`; `wagering.e2e-spec.ts` (31 cases) |
| 4 Transaction reads | done | `GET /wagering/transactions/:id`, `GET /providers/:p/wagering/transactions/:ext`; `WagerTransactionRepository.findById`, `toStoredBody` |
| 5 Ledger pagination | done | `cursor.ts`, `WalletLedgerRepository.page`; 120 entries as 50/50/20, an entry between pages |
| 6 Reconciliation | done | `WalletLedgerRepository.reconcile` (one statement), error log on a mismatch, no repair |
| 7 Postman | done | `documentation/postman_collection.json` and `postman_environment.json`, linked from `tests.md` |
| 8 Close out | done | gates, `ARCHITECTURE.md` (D9 implemented, D13, D15, cursor, reconciliation, race), this log, `plan.md` |

Bugs found on the way:

- `player_id` is a `uuid` column but the DTO accepted any string: a non-UUID `playerId` reached Postgres and came back as a retryable 503. `playerId` is `z.uuid()` now (first wagering e2e run).
- The global filter replaced the readiness probe's 503 body (`{postgres, sqs}`) with a generic one, hiding which dependency was down. `HttpException` bodies are kept as `details` (found when `/health/ready` failed in Compose).
- `seq::text AS seq` made `ORDER BY seq` sort as text: pages of a long ledger repeated rows. Found by the balance-chain assertion of the 120-entry test, not by the 3-row repository test.
- Compose passed `DATABASE_URL` from `.env` (host `localhost`), which inside the container is the container itself: every request failed with `ECONNREFUSED`. `docker-compose.yaml` now builds the URL for `nest-app` with host `db`. A fresh database also needs `docker compose exec nest-app bun run migration:up` (until then every wallet request is 503).

Decisions (details in `ARCHITECTURE.md`): D9 implemented with two mapping functions; D13 zod, shape only; D15 `AuthGuard` class; cross-wallet same-key race handled by one retry; ledger cursor is `seq`; reconciliation is one statement.

Open items for the next phases:

- **Phase 6 (outbox):** `claimDue` with `FOR UPDATE SKIP LOCKED`, publisher, retries, queue provisioning. The reconciliation mismatch hook (phase 9) is marked in `wallet.controller.ts`.
- **Phase 7 (consumer):** the 503 mapping of `55P03` is done; the consumer must treat a lock timeout as retryable (leave the message on the queue).
- **Housekeeping:** the per-step time was not recorded; the `db` container is named `localhost` (`container_name: ${DATABASE_HOST}`), which works but confuses; a repeated query parameter (`?limit=1&limit=2`) is a 400 by accident of the schema, not by a test.

## Phase 6: outbox publisher (done 2026-10-21)

State: `bun run test` 392 passed, `bun run test:e2e` 190 passed (three runs in a row), `tsc`, `nest build` and lint clean.

| Step | State | Detail |
|---|---|---|
| 0 Queues and support | done | `localstack/init/ready.d/queues.sh` (idempotent, `MAX_RECEIVE=5`), LocalStack healthcheck and `service_healthy` for `nest-app`, `messaging.config.ts`, `SQS_CLIENT` provider, `test/support/sqs.ts` |
| 1 `OutboxMessage` | done | domain class (`enqueue`, `rehydrate`, `markPublished`, `scheduleRetry`, 5 s base / 300 s cap) and mapper; `domainPurity` now covers `src/messaging` |
| 2 `claimDue` and `save` | done | `FOR UPDATE SKIP LOCKED` in plain SQL inside the transaction; `outboxClaim.spec.ts` |
| 3 `OutboxPublisher` | done | `tick(now)` plus timer with in-flight guard, `WORKERS_ENABLED` switch, shutdown awaits the tick |
| 4 Integration tests | done | `outbox.spec.ts`: happy path, rollback, crash before and after the send, two publishers over 100 rows, retry by backoff, one bad message in 5, timer on and off |
| 5 Health | done | `HealthService` uses `SQS_CLIENT` and `GetQueueAttributes` on the main queue; `health.e2e-spec.ts` (503 when the queue is missing, 200 once it exists) |

Bugs found on the way:

- Raw `execute()` skips MikroORM hydration: `timestamptz` came back as a string (`'2026-10-21 12:00:00+00'`), not a `Date`, and columns were snake_case. `claimDue` aliases the columns to the row properties and converts the three dates before the mapper. Found by the first claim spec run.
- LocalStack returns queue URLs on `sqs.us-east-1.localhost.localstack.cloud`, which needs public DNS; one run failed with `ENOTFOUND`. The client sets `useQueueUrlAsEndpoint: false` so it always uses the configured endpoint.
- The e2e app boot would have started the real publisher timer against the dev queues; `vitest.config.e2e.ts` sets `WORKERS_ENABLED=false`.

Decisions (details in `ARCHITECTURE.md`, "Outbox publisher"): D12 as planned (third queue `wager-events`, standard); claim and send in one transaction.

Open items for the next phases:

- **Phase 7 (consumer):** `sendWagerMessage` in `test/support/sqs.ts`; the app config of `maxReceiveCount` must equal `MAX_RECEIVE` in `queues.sh`; consumers of `wager-events` dedupe by `eventId`.
- **Phase 9:** published and failed counters from `tick`'s result; a stuck-row alert (`attempts` high).
- **Housekeeping:** an `Error: connection terminated unexpectedly` line is printed by one existing e2e spec on every run (the run still passes); not investigated.

## Phase 7: consumer, inbox, pending-reference worker (done 2026-10-21)

State: `bun run test` 427 passed, `bun run test:e2e` 220 passed (three runs in a row), `tsc`, `nest build` and lint clean.

| Step | State | Detail |
|---|---|---|
| 0 Message schema, inbox class, helpers | done | `messageSchema.ts` (extends the HTTP schema, reuses its `toCommand`), `InboxMessage`, `sendWagerMessage` and `buildApp` in `test/support/sqs.ts` |
| 1 Error classification | done | `classify` plus `InboxPayloadMismatchError`; table in `ARCHITECTURE.md` |
| 2 `recordFailure` and `reprocess` | done | shared `decide` with `execute`; `findDuePendingReference` (`SKIP LOCKED`); `recordFailureReprocess.spec.ts` (11 tests) |
| 3 `WagerConsumer.pollOnce` | done | ack after commit, permanent to DLQ, transient retried, last receive `recordFailure` then DLQ then delete |
| 4 Graceful shutdown | done | `beforeApplicationShutdown`, aborted long poll, in-flight awaited, unstarted messages released with visibility 0 |
| 5 `PendingReferenceWorker` and wiring | done | registered in `WalletModule`; timer and `WORKERS_ENABLED` switch like the publisher |
| 6 Consumer tests | done | `consumer.spec.ts`, 14 tests against real SQS: duplicate delivery, crash after commit, malformed, unknown wallet, hash mismatch, business rejection, five-receive DLQ with `FAILED` and redrive, database down for `recordFailure`, failing DLQ send, shutdown mid-message, timer loop, `maxReceiveCount` equals the redrive policy |
| 7 Pending-reference tests | done | `pendingReference.spec.ts`, 5 tests: both out-of-order flows, D3 timeline to `REFERENCE_NOT_FOUND`, concurrent ticks, one failing row |

Checked by hand:

- Compose stack: one message sent to the real `wager-transactions.fifo` was consumed by the running `nest-app` (wallet 100.00 to 90.00). `docker compose stop nest-app` while idle (consumer in its long poll): 0.5 s, exit code 0.
- Real `SIGTERM` mid-message: `node dist/main` on the host, three messages in one batch, the wallet row locked from a `psql` session so the first was stuck. The process waited for the commit (about 1.6 s), the first message was `PROCESSED` and deleted, the other two were visible again at once, DLQ empty. Exit code 143 is Nest re-raising the signal after the hooks, i.e. the graceful path. Procedure in `ARCHITECTURE.md`, "Known limits".

Decisions: see "SQS consumer, inbox and pending-reference worker" in `ARCHITECTURE.md`.

Differences from the phase document: consumer and worker live in `WalletModule`; `pollOnce(waitSeconds = 20)` takes the wait so tests do not hold for 20 s; `beforeApplicationShutdown` instead of `OnApplicationShutdown`; the unstarted rest of a batch is handed back whenever a message stays (order per wallet); `InvalidWagerTransactionError` and `InvalidMovementError` are permanent; the inbox hash mismatch is now detected in the use case.

Open items:

- `OutboxPublisher` still closes on `onApplicationShutdown`; check it cannot race the ORM close.
- Test queues now carry the real redrive policy; a test with the 6th receive waits about 13 s (the suite takes about 35 s for the consumer spec).
- No metrics yet for received, acked, dead-lettered and failed counts (phase 9).

## Phase 8: multi-instance and restart (done 2026-10-21)

State: `bun run test:multi` 8 tests in 6 files, three runs in a row (about 26 s each); `bun run test` 427 and `bun run test:e2e` 220 still green; `tsc` and lint clean. No production code changed.

| Step | State | Detail |
|---|---|---|
| 0 `startInstances`, build step, script | done | `test/support/instances.ts` (spawns `node dist/main.js`, per-instance output buffer, `/health/ready` polling with a 30 s deadline, `stop()` kills with `SIGKILL`), `test/support/globalSetupMulti.ts` (builds when `dist/` is stale), own config `vitest.config.multi.ts`, script `test:multi`; `test:e2e` now excludes `test/integration/multi` |
| 1 HTTP race across 3 instances | done | `http.spec.ts`: 10 `PROCESSED` + 20 `INSUFFICIENT_FUNDS`; same key over 3 ports: one debit, 29 replays. Sabotage check done (wallet lock removed locally, both tests failed, reverted) |
| 2 Consumers and publishers | done | `consumer.spec.ts` (200 messages, 20 wallets; cross-channel same key), `outbox.spec.ts` (300 rows, 3 publishers) |
| 3 Restart (`SIGKILL`) | done | `restart.spec.ts`: 576 transactions, kill after 30 rows stored (landed at 35 to 42 rows with 12 to 21 messages in flight), replacement started, stored keys equal sent keys |
| 4 `SIGTERM` | done | `shutdown.spec.ts`, exit status 143 (not 0, see below) |
| 5 Close out | done | docs below; three green runs; manual three-container run tried by hand |

Shared helpers: `test/support/multi.ts` (`waitUntil`, `newTx`, `toMessage`, `post`, `postWithRetry`, `waitForSettled`, `expectEveryEventPublished`, `useMultiInstances`).

Differences from the phase document:
- Separate `vitest.config.multi.ts` and `globalSetupMulti.ts` instead of reusing the e2e config: the e2e config would otherwise run the multi specs inside `test:e2e` and the build step would slow every e2e run. The build is done by the global setup only when `dist/` is stale, so `test:multi` does not call `bun run build`.
- `SIGTERM` exits with status 143, not 0: Nest re-raises the signal after the hooks (already recorded in phase 7). The helper reports shell-style statuses (143, 137).
- `instances.exited` resolves to a number (never `null`): a process killed by a signal is reported as 128 + signal.
- The restart and shutdown load is sent in waves of 20 (queue) and 4 (HTTP) while the test watches the database; HTTP clients retry the same key on another instance, as a provider would after a dropped connection.

Checked by hand: three containers (`docker compose run ... node dist/main.js` on :3001 and :3002 plus the compose app on :3000) against the dev database and compose queues: 30 BETs of 10.00 on 100.00 spread over the ports gave 10 x 200 and 20 x 422, reconciliation `consistent: true`. Procedure in `deployment.md`.

Decisions: see "Multi-instance correctness" in `ARCHITECTURE.md`.

Open items:
- `INSTANCE_ID` was not read by the app when this phase closed; since then the startup log line carries it (see "Instance id" below). Tests still cannot assert that every instance did a share of the work.
- Kill and `SIGTERM` timing is by database state, not by code line; which message the victim held is not controlled.
- Single machine, single Postgres.

## Phase 9: observability (done 2026-10-22)

State: `bun run test` 429, `bun run test:e2e` 223, `bun run test:multi` 8; `tsc`, build and lint clean. One production dependency added: `prom-client`.

| Step | State | Detail |
|---|---|---|
| 0 `MetricsService`, `/metrics` | done | `src/observability/` (`metrics.service.ts`, `metrics.controller.ts`, `observability.module.ts`, global); all names from the phase contract |
| 1 Instrumentation | done | `execute` (counters after commit, processing histogram, duplicates), `lockWallet` (lock-wait histogram), `reprocess`/`recordFailure`, consumer (retries, DLQ), publisher (retries), reconciliation |
| 2 Outbox lag gauge | done | `collect()` on scrape; e2e test shows it grows with workers off |
| 3 JSON logs | done | `ConsoleLogger({ json: true })`, `logEvent` with a typed allow-list, consumer passes the SQS `MessageId` as correlation id; every `logger.*(\`...${error}\`)` replaced |
| 4 Tests | done | `test/e2e/metrics.e2e-spec.ts` (names, processed/rejected/replay counters, histograms count, lag gauge), `test/unit/logEvent.spec.ts` |

Checked by hand on the compose app: three requests with `x-correlation-id: abc` (processed, replay, rejected) gave three JSON lines with `"correlationId":"abc"`, ids and status only, and the matching counters on `/metrics`.

Differences from the phase document:
- `logEvent` takes a `level` (and an optional stack) because the call sites are warnings and errors as well as info.
- The allow-list gained `errorType`, `httpStatus`, `method`, `path` (error class name, HTTP error log), and no error message at all.
- The reconciliation e2e test no longer expects balances in the log (they were in the phase 5 log line); it expects `{event: 'reconciliation.mismatch', walletId}`.
- `wager_duplicates_total` also counts `DuplicateExternalTransactionError`.
- The compose container needs `docker compose up -d --build -V nest-app` after `bun add` (anonymous `node_modules` volume).

Decisions: see "Observability" in `ARCHITECTURE.md`.

Open items:
- No `instance` metric label (the scraper adds one); `INSTANCE_ID` is only in the startup log line.
- Consumer received/acked counts and the 5xx stack in JSON mode were not checked beyond the unit test.

## Phase 10: documentation (done 2026-10-22)

| Step | State | Detail |
|---|---|---|
| 0 `ARCHITECTURE.md` | done | index with D-numbers, stale Money/D1 text fixed, HTTP 500 row, concurrency walkthrough (lock order), consolidated Limitations (each with ceiling and way up), Considered-not-implemented, D16 |
| 1 Reference documents | done | `taxonomy.md` created from `failureCode.ts`, `toHttp.ts`, `src/events/`, `queues.sh`, `metrics.service.ts`, `logEvent.ts`; environment table in `deployment.md` from `grep process.env`; coverage figure in `tests.md`; empty `test.md` deleted; this log's stale sections replaced by the final status table |
| 2 README and Postman | done | "Setup and commands" section on top of `README.md`; Metrics request added; `newman`: 35 requests, 69 assertions, 0 failed, on the live stack and on the fresh clone |
| 3 Fresh-clone dry run | done | below |

**Dry run (2026-10-22).** A copy of what a commit contains (tracked plus untracked files, no `.env`, `node_modules`, `dist`) in a temp directory, following only the README: `cp .env.example .env`, `docker compose up -d --build` (22 s), `docker compose exec nest-app bun run migration:up`, `/health/ready` 200, `/metrics`, `bun run test` (429), `bun run test:e2e` (223), `bun run test:multi` (8), `newman` (35 requests, 0 failed). The clone's own stack was removed with `down -v` afterwards.

Guesses found and fixed:
- **`bun install` after `docker compose up` fails with `EACCES`**: Docker creates `node_modules/` on the host as root (anonymous volume mount point). README and `deployment.md` now say `bun install` first, with the recovery commands.
- The Start section never said to apply the migration; the app does not migrate on boot, so every wallet request failed until it ran. Added to README and `deployment.md`.
- `outbox.tick_failed` errors appear in the log between `compose up` and `migration:up` (tables missing); they stop once the migration is applied. Documented as expected.
- `deployment.md` still listed "no queues" and "boot race" as known problems; removed (queues are created on start, Compose has healthchecks).

Also changed in this phase: `OutboxPublisher` now stops in `beforeApplicationShutdown` like the other workers (it used `onApplicationShutdown`, which could race the ORM close); the two shutdown tests call the new name.

Not run: the dry run was on the same machine and the same Docker daemon, so it does not prove a different OS or an empty Docker image cache. `errorType` in logs is the error class name, which the pg driver reports as just `error` for database errors; the message is left out on purpose (it can quote values).

## Instance id (2026-10-22)

`main.ts` logs `{"event":"app.started","instanceId":...,"port":...}` once, after `listen`. `instanceId` is `INSTANCE_ID` or the hostname. Every JSON line already has `pid`, so the startup line is the key that attributes the rest. `LogFields` gained `instanceId` and `port`; `multi/smoke.spec.ts` asserts each child logs its own id. Not done: the id on every line, or as a metric label.

## Extras (2026-10-22)

- **Retry counters at 0:** the three `wager_retries_total` sources are exported from start (`MetricsService` constructor), tested in `metrics.e2e-spec.ts`.
- **Instance id everywhere:** `src/observability/instance.ts`; `logEvent` adds `instanceId` to every line, the registry adds the `instance_id` label to every metric (not `instance`, which Prometheus owns). `app.started` logs it with the port. The two log-shape tests were updated.
- **Load test:** `bun run test:load` (`test/load/run.ts`, `autocannon` and `@types/autocannon` as dev dependencies), results and analysis in `load-test.md`. Finding: the outbox publisher's ceiling is about 50 events/s (one batch of 50 per tick), so the sustainable rate is about 25 tx/s; the HTTP path itself did 240-270 req/s on one hot wallet and 440-470 over 200 wallets with 0 errors and the ledger invariant intact. Recorded as a limitation with ways up; the publisher was not changed.

## Known issues and risks

- `DATABASE_URL` is read by MikroORM only; `bun` expands the `${...}` values of `.env`, plain `node` does not (see `deployment.md`, migrations).
- The compose `nest-app` keeps its own anonymous `node_modules` volume: after `bun add`, run `docker compose up -d --build -V nest-app`.
- Limits and risks of each mechanism (lock held while publishing, FIFO head-of-line blocking, no retention jobs, single machine) are in `ARCHITECTURE.md`, "Limitations".

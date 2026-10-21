# Progress log

Status against the README (`README.md`, section numbers in brackets). Updated 2026-10-21.

## Done

| Area | What exists | Where |
|---|---|---|
| Project skeleton | NestJS 12, TypeScript strict, ESM (`nodenext`), vitest, oxlint | `package.json`, `tsconfig.json` |
| Package manager | bun (was npm). Bun is only the package manager/script runner; Nest still runs on Node | `bun.lock`, `Dockerfile`, `packageManager` field |
| Docker Compose | `nest-app` (live reload via bind mount), `db` (postgres:13), `localstack` (SQS only) | `docker-compose.yaml` |
| ORM wiring [4] | MikroORM v7 + `@mikro-orm/nestjs`, config from `DATABASE_URL`, schema-file discovery (`*.schema.ts`) | `src/mikro-orm.config.ts`, `src/app.module.ts` |
| Health checks [9] | `GET /health/live` always 200. `GET /health/ready` probes Postgres (`select 1`) and SQS (`ListQueues`), 2 s timeout each, 503 with per-dependency booleans on failure | `src/health.*.ts` |
| Money value object [6.1] | `Money` on `decimal.js`: scale-2 string in/out, immutable, currency-mismatch errors, sign predicates. 38 unit tests passing (`0.1 + 0.2`, invalid inputs, `negate` of zero, mismatch on every binary op, JSON round trip) | `../src/money/money.ts`, `src/money/dto/money.props.dto.ts`, `test/money/money.spec.ts` |
| Domain model [6.0 to 6.4, 7.2] | Phase 2 complete: `Money`, `Wallet` (debit/credit return the ledger entry, `openingEntry`), `WalletLedgerEntry`, `WagerTransaction` (rule table, state machine, retry state, `checkReference`, `ledgerDirectionFor`), `payloadHash`, `backoffMs`, typed errors, `FailureCode`. 280 unit tests. See "Phase 2" below | `src/money`, `src/wager`, `src/wallet`, `test/unit` |
| SQS client | `@aws-sdk/client-sqs` added; endpoint/region/credentials via `AWS_*` env vars (no config code) | `docker-compose.yaml` |

## Decisions taken so far (Money decisions are already in `ARCHITECTURE.md`; the rest are to be copied)

- **LocalStack pinned to 4.4.** `latest` and `-pro` abort at startup without `LOCALSTACK_AUTH_TOKEN`. 4.4 runs with no account, so a reviewer can `docker compose up` cold. Cost: no security patches, older SQS emulation.
- **Container runs as `node` (uid 1000).** With the project bind-mounted, a root container left root-owned `dist/` on the host and broke `bun run build`.
- **Readiness probes use the real clients, not HTTP calls to the containers.** Postgres has no HTTP endpoint, and `/_localstack/health` only exists in LocalStack, so it would pass while the app's own SQS config was broken.
- **MikroORM connects lazily**, so `orm.checkConnection()` reports "not established" until the first query. The probe runs an actual query instead.
- **vitest/coverage pinned to ^5.** `^4` crashes npm's resolver (`edgesOut` error). Irrelevant under bun but kept at 5.

## Not done (README requirements still open)

| Area | Points | Gap |
|---|---|---|
| Domain model [6] | 20+10 | `Money` done. `Wallet` partial (`open` only). `WagerTransaction` and `WalletLedgerEntry` are compile-only stubs. Domain must not import ORM or Nest decorators, so map via `EntitySchema` |
| Migrations [4] | - | None. Must be versioned and reversible. No migration scripts in `package.json` yet |
| API [9] | - | No wallet or transaction endpoints, no reconciliation endpoint |
| Idempotency, concurrency [7, 8] | 35 | Nothing. Needs persistent dedup, locking strategy (`LockMode` or versioning), multi-instance test |
| SQS consumer, inbox [10] | 15 | Queues `wager-transactions.fifo` and `-dlq.fifo` are not provisioned. No consumer, inbox, retry/DLQ |
| Outbox [11] | - | None. No publish-after-commit |
| Observability [12] | 5 | Only health. No structured logs or metrics |
| Tests [13] | 10 | One placeholder spec, and it currently fails (`app.service.ts` returns `Hello World 5!`). No integration or concurrency tests |
| Postman collection | - | Required by project instructions, missing |
| Docs | 5 | `ARCHITECTURE.md` started (Money section only). `tests.md` and taxonomy file missing. `deployment.md` written |
| Auth [2] | 0 | Not started. README accepts skipping if the decision and extension point (no-op guard/port) are documented |

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

## WagerTransaction stubs: decisions deferred (superseded)

**Superseded 2026-10-20:** every point below was decided (D1 to D11, D17, D18) and is written in `ARCHITECTURE.md` and `plan.md`. Kept only as history; delete when convenient. Original text:

Stubs exist only so `tsc` passes. Props types (`CreateWagerTransactionProps`, `WagerTransactionState`, `CreateLedgerEntryProps`, `LedgerEntryState`) are `unknown`. Open points, to decide before implementing:

- **State machine.** Valid transitions undefined. Proposal: `PENDING` to any of the other four; `PENDING_REFERENCE` to `PROCESSED`/`REJECTED`/`FAILED`/itself; terminals throw `InvalidTransactionStateError`. Decide whether `processedAt` is set only on `PROCESSED`.
- **`PENDING_REFERENCE` retry state** (attempts, `nextAttemptAt`, first-seen for TTL) has no field in the skeleton [7.1]. Nullable fields on the transaction, or a separate table.
- **`create` validation by kind.** `OPENING` must be creatable internally (block it at API/consumer, not in the factory). Reference required for `REFUND`/`ROLLBACK`, forbidden for `BET`/`OPENING`, optional for `WIN`, unspecified for `LOSS`. Amount must be positive; zero `LOSS` and zero `OPENING` undecided.
- **`ledgerDirectionFor`.** `OPENING`/`WIN`/`REFUND` credit, `BET` debit, `LOSS` no entry, `ROLLBACK` inverse of the reference.
- **Reference rules 2-5 have no method.** Needs a pure check returning a `FailureCode`. Rule 4 is ambiguous: read literally, a `BET` could be both refunded and rolled back (double credit). Proposed reading: at most one `PROCESSED` reversal per transaction, enforced by a unique index or the wallet lock, not only in memory.
- **Idempotency.** Relation between `idempotencyKey`, `(providerId, externalTransactionId)` and `payloadHash` undefined. Proposal: unique `(providerId, idempotencyKey)` and `(providerId, externalTransactionId)`; same key with another hash is 409.
- **`FailureCode` taxonomy** [7.2] and the `reject` vs `fail` boundary (`fail` on DLQ / non-retryable) are open.
- `Wallet.rehydrate`, `debit` and `credit` are also still `todo`.

## Known issues and risks

- `src/app.service.ts` and its spec disagree; `bun run test` fails.
- `health.service.ts` creates its own `SQSClient`. Move to a shared provider when the consumer is added.
- SQS probe checks reachability only; it will not notice a missing queue. Switch to `GetQueueAttributes` once queues exist.
- `.env` holds the DB password and is used by Compose. It is git-ignored; there is no `.env.example` for reviewers yet.
- `DATABASE_URL` ends in `?schema=public` (Prisma style). Ignored by the driver; set `schema` in the MikroORM config if a non-default schema is wanted.
- No `healthcheck`/`condition: service_healthy` in Compose, so the app can start before Postgres accepts connections. Readiness covers this at runtime, but the first MikroORM query may race at boot.
- `Money` throws plain `Error`s (distinct messages, no typed classes). Add `InvalidMoneyError` / `CurrencyMismatchError` before the HTTP layer so a filter can map to 422. Tests only assert `toThrow()`.
- `Money.equals` throws on currency mismatch (decision recorded in `ARCHITECTURE.md`). Revisit if a caller needs a non-throwing comparison.
- `Money.from` accepts negatives (the domain needs them for signed differences); the request DTOs reject them (phase 5, `money.dto.ts`).
- `Money` persistence mapping is settled (D10: `numeric(19,2)` + `char(3)`, mapper functions, proven by the phase 3 round-trip spec).
- `tests.md` and the coverage target for the 80% goal are untracked.

## Suggested next steps (smallest path to the scoring weight)

1. ~~`Money` value object + unit tests~~ done 2026-10-20.
   - Next in the domain: decide the open points under "WagerTransaction stubs", then implement `WagerTransaction`, `WalletLedgerEntry`, `Wallet.debit/credit` with unit tests.
2. `Wallet` / ledger schemas + first migration, with up/down scripts.
3. Submit-transaction use case with persistent idempotency key and row lock; concurrency test against real Postgres.
4. Provision queues (LocalStack init script), then inbox/outbox and consumer.
5. Fill `ARCHITECTURE.md` from the decisions above as each lands.

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

## Phase 4: use cases (in progress, steps 0 to 6 done, 2026-10-21)

State: `bun run test` 291 passed, `bun run test:e2e` 79 passed (16 repositories, 5 createWallet, 10 submitWagerTransaction, 13 references, schema, mappers, support, 2 health e2e), `tsc`, `nest build` and lint clean.

| Step | State | Detail |
|---|---|---|
| 0 Test support | done | `test/support/ledger.ts` (`assertLedgerMatchesBalance`), `fixtures.ts` (`openWallet`, `betCommand`, `runInParallel`) |
| 1 Errors and events | done | `IntegrationEvent` and the four events with `events.spec.ts`; the three request errors exported with typed fields, `errors.spec.ts` |
| 2 Repositories | done | wallet, wager transaction, ledger, outbox (enqueue), inbox; `test/integration/repositories.spec.ts` 16 tests including the lock actually blocking a second locker and a stale-version `save` |
| 3 `CreateWallet` and modules | done | `CreateWalletUseCase`, `MessagingModule`, `WalletModule`, `@Injectable()` on the repositories; `createWallet.spec.ts` tests 13a to 13d plus a Nest wiring test |
| 4 `SubmitWagerTransaction`, simple kinds | done | `run` (lock, build, wallet checks, apply, events, persist), `apply` free of I/O for the phase 7 reuse; tests 1 (the 80.00 race, three runs), 6 without references, 9b, unknown wallet, blank `roundId` |
| 5 Idempotency | done | key lookup (replay with stored `balanceAfter`, `IdempotencyConflictError`), external id lookup (`DuplicateExternalTransactionError`); tests 2 (50 parallel, 1 original and 49 replays), 3, 3b, 4, 5. Review added the missing null `balanceAfter` guard (`tsc` failed) |
| 6 References and reversals | done | `resolveReference` (pending / rejected / found, `checkReference`, `findReversalOf`) and the branch in `run`; `references.spec.ts`: tests 6, 6b, 7, 7b, 7c, 8, 8b, 9 |

Bugs found on the way (step 6): the first `resolveReference` never returned its computed outcome, so every reversal was applied whatever the reference status (a refund of a rejected bet credited the wallet). Caught in review, fixed, covered by tests 7 and 7b. Lesson: an implicit-`any` local assigned in a `switch` compiles even when nothing reads it.

Bugs found on the way: raw SQL through `em.getConnection().execute(sql, params)` ran outside the transaction (it hung the stale-version test, and would have broken inbox and atomicity silently); fixed by passing `'all', em.getTransactionContext()`. The scaffold caught `DuplicateWalletError` where the ORM throws `UniqueConstraintViolationException`. `domainPurity` treated `wallet.module.ts` as domain code; `module` joined the adapter suffixes.

Decisions (details in `ARCHITECTURE.md`, "Use case wiring"): two modules, no `WagerModule`; unique violation translated after the rollback; wager finders return `balanceAfter`.

Open: `src/wager/wagerTrasanction.repository.ts` has a typo in its name (rename to `wagerTransaction.repository.ts`); the `5s` lock timeout is a guess until step 9; the submit use case file is `SubmitWagerTransaction.usecase.ts` (capital S). Next: step 7 (inbox and atomicity). Also open: unique-violation retry for the cross-wallet same-key race (decision documented, not implemented).

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
- `Money.from` accepts negatives; rejecting them in input contracts is the request DTO's job and is not written yet.
- `Money` persistence mapping is settled (D10: `numeric(19,2)` + `char(3)`, mapper functions, proven by the phase 3 round-trip spec).
- `tests.md` and the coverage target for the 80% goal are untracked.

## Suggested next steps (smallest path to the scoring weight)

1. ~~`Money` value object + unit tests~~ done 2026-10-20.
   - Next in the domain: decide the open points under "WagerTransaction stubs", then implement `WagerTransaction`, `WalletLedgerEntry`, `Wallet.debit/credit` with unit tests.
2. `Wallet` / ledger schemas + first migration, with up/down scripts.
3. Submit-transaction use case with persistent idempotency key and row lock; concurrency test against real Postgres.
4. Provision queues (LocalStack init script), then inbox/outbox and consumer.
5. Fill `ARCHITECTURE.md` from the decisions above as each lands.

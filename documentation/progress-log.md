# Progress log

Status against the README (`README.md`, section numbers in brackets). Updated 2026-10-20.

## Done

| Area | What exists | Where |
|---|---|---|
| Project skeleton | NestJS 12, TypeScript strict, ESM (`nodenext`), vitest, oxlint | `package.json`, `tsconfig.json` |
| Package manager | bun (was npm). Bun is only the package manager/script runner; Nest still runs on Node | `bun.lock`, `Dockerfile`, `packageManager` field |
| Docker Compose | `nest-app` (live reload via bind mount), `db` (postgres:13), `localstack` (SQS only) | `docker-compose.yaml` |
| ORM wiring [4] | MikroORM v7 + `@mikro-orm/nestjs`, config from `DATABASE_URL`, schema-file discovery (`*.schema.ts`) | `src/mikro-orm.config.ts`, `src/app.module.ts` |
| Health checks [9] | `GET /health/live` always 200. `GET /health/ready` probes Postgres (`select 1`) and SQS (`ListQueues`), 2 s timeout each, 503 with per-dependency booleans on failure | `src/health.*.ts` |
| Money value object [6.1] | `Money` on `decimal.js`: scale-2 string in/out, immutable, currency-mismatch errors, sign predicates. 38 unit tests passing (`0.1 + 0.2`, invalid inputs, `negate` of zero, mismatch on every binary op, JSON round trip) | `../src/money/money.ts`, `src/money/dto/money.props.dto.ts`, `test/money/money.spec.ts` |
| Domain vocabulary [6.3, 6.4, 7.2] | Kind/status enums, `FailureCode` (ten codes + `PROCESSING_ERROR`), typed errors, `backoffMs`. `WagerTransaction`, `WalletLedgerEntry` and `payloadHash` are still stubs (bodies `not implemented` / `TODO`). See "Phase 2" below | `src/wager/*`, `src/wallet/walletLedgerEntry.ts` |
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

## Phase 2: domain model (verified 2026-10-20, 5:45 pm, uncommitted work on top of `67c2d08`)

Plan item numbers are those of `plan.md`, Phase 2. About 50% done. State: `bun run test` 67 passed (Money 40, `backoffMs` 9, `payloadHash` 18: specs in `test/unit/wager/`; none yet for wallet, ledger, transaction); **`tsc` fails** with one error, `src/wager/wagerTransaction.ts(154,9) TS1109 Expression expected`, from the half-written `assertWagerTransactionReference`.

| Item | State | Detail |
|---|---|---|
| 1 Money errors | done | `InvalidMoneyError`, `CurrencyMismatchError` (name fixed); no `expected`/`received` fields (optional) |
| 2 Money uses them | done | typed errors everywhere in `src/money`; spec asserts the classes (verified 5:35 pm) |
| 3 `FailureCode` | done | ten codes + `PROCESSING_ERROR`; stale `todo` comment, `MisMatch` casing typos in member names |
| 4 `InvalidTransactionStateError` | done | moved into `src/wager/errors.ts` (with `InvalidWagerTransactionError`); the separate file was deleted |
| 5 `payloadHash` | done, tested | verified by running: order-independent, `Money` via `toJSON`, `undefined` = absent, `idempotencyKey` ignored, each of the 9 fields changes the hash; golden `b1d776f3…fb09c` for the plan's fixed input |
| 6 `backoffMs` | done, tested | table values match; integer guard throws for negative, fractional and `NaN`; policy constants still to add in `wagerTransaction.ts` |
| 7 `WagerTransaction` | started | 7a types final (state fields still `_`-prefixed); 7c "from terminal throws" guard in the four transitions, bodies `notImplemented()`, `markPendingReference` lacks `now`; 7b stub breaks the build; 7d to 7g not started; `attempts` / `nextAttemptAt` not in the constructor |
| 8 `WalletLedgerEntry` | not started | stub with `unknown` types |
| 9 `Wallet` | not started | `open` only (still uses `new Date()`, public `_createdAt`, plain `Error`) |
| Tests | partial | `backoff.spec.ts` and `payloadHash.spec.ts` written (incl. golden hash), Money spec extended with typed-error checks; `wagerTransaction`, `wallet`, `walletLedgerEntry` and `domainPurity` specs still missing; purity check is trivially true today (no `@nestjs` / `@mikro-orm` import in `src/money`, `src/wager`, `src/wallet`) |

Next, in order: make `tsc` green (delete `assertWagerTransactionReference`, rules go into `create`), write the specs for 5 and 6, fix the `FailureCode` comment, then 8, 9, 7 each with its spec. Per-item references are in `plan.md` Phase 2, "References to follow".

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
- `Money` persistence mapping (`numeric(19,2)` + `char(3)` vs cents) is undecided; settle it with the Wallet schema.
- `tests.md` and the coverage target for the 80% goal are untracked.

## Suggested next steps (smallest path to the scoring weight)

1. ~~`Money` value object + unit tests~~ done 2026-10-20.
   - Next in the domain: decide the open points under "WagerTransaction stubs", then implement `WagerTransaction`, `WalletLedgerEntry`, `Wallet.debit/credit` with unit tests.
2. `Wallet` / ledger schemas + first migration, with up/down scripts.
3. Submit-transaction use case with persistent idempotency key and row lock; concurrency test against real Postgres.
4. Provision queues (LocalStack init script), then inbox/outbox and consumer.
5. Fill `ARCHITECTURE.md` from the decisions above as each lands.

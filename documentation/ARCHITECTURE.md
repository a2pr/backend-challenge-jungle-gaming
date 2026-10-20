# Architecture decisions

Decisions taken so far, section numbers refer to `README.md`. Decision numbers (D1 to D18) follow `plan.md`; D1 to D11, D17 and D18 were taken on 2026-10-20 (phase 1) and D12 to D16 are taken in the phase that needs them. Infrastructure decisions (LocalStack pin, container user, readiness probes, lazy MikroORM connection) are in `progress-log.md` and will be moved here as each area is implemented.

## Money value object [6.1, 5.1]

Code: `../src/money/money.ts`, DTO `src/money/dto/money.props.dto.ts`, tests `test/money/money.spec.ts`.

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Decimal type | `decimal.js` (`Decimal`), declared in `package.json` | README skeleton types `value` as `Decimal`. Exact base-10 arithmetic; no `number` anywhere in the class (eliminatory rule 5.1). The alternative was `bigint` minor units: no dependency, but it drifts from the README signature and needs manual parsing/formatting |
| Boundary representation | `amount` is always a decimal **string**, `currency` a string | JSON numbers are IEEE doubles, so a string is the only lossless wire format |
| Scale | Fixed at 2, enforced on input with `/^-?\d+\.\d{2}$/` and on output with `toFixed(2)` | Rejects `NaN`, `Infinity`, `1e3`, empty, `25`, `25.0`, `1.005`, `1,00`. `toFixed` avoids `Decimal.toString()` emitting `"25"` or `"1e+21"` |
| Currency | `/^[A-Z]{3}$/` shape check only | ISO-4217 shape is enough for the challenge. No code list, so `XXX` or `ZZZ` pass |
| Immutability | `private constructor`, `readonly` fields, every operation returns a new `Money` | README 6.1. `Decimal` operations are themselves immutable |
| Currency mismatch | `add`, `subtract`, `isLessThan` **and `equals`** throw | A cross-currency comparison is a programming error, not a "false" answer. A silent `false` from `equals` would hide a wallet/transaction currency bug. Trade-off: `equals` is not usable as a general predicate across unknown currencies |
| Sign handling in `from` | Negative amounts are **accepted** by `Money.from` | Balances, `subtract` results and ledger `balanceBefore/After` can be negative intermediates, and `negate()` must round-trip through `toJSON`/`from`. "No negatives in input contracts" (6.1) is enforced at the request DTO validation layer, not in the value object |
| Sign predicates | `isPositive` is `gt(0)`, `isNegative` is `lt(0)` | `Decimal.isPositive()` returns `true` for zero |
| Domain purity | No imports from `@nestjs/*` or `@mikro-orm/*` | README 6.1. Persistence mapping lives in an `EntitySchema` (infrastructure layer) |

### Not implemented yet / open

- **Typed errors.** Failures are plain `Error`s with different messages. Add `InvalidMoneyError` and `CurrencyMismatchError` before the HTTP layer so a filter can map them to 422 without string matching.
- **Persistence mapping.** Two options: `numeric(19,2)` + `char(3)` columns rehydrated through a MikroORM custom type or embeddable, or `bigint` cents. Decision deferred to the Wallet schema work.
- **Request DTO validation** (negative rejection, max amount guard) is not written; it belongs to the API layer.
- **Rounding/division.** None exists. Scale is fixed at 2 and there is no multiply/divide, so rounding mode is not a decision yet. If fees or splits are added, a rounding mode (banker's vs half-up) must be chosen explicitly.
- **Max amount.** `Decimal` has no overflow, but the database column (`numeric(19,2)`) does. Validate at the boundary.
- **Currency list.** Only the shape is checked.
- **Multi-currency.** The model is multi-currency, but the challenge may run with `BRL` only (README 6.1). The mismatch behavior is covered by tests.

## State machine and scenarios [6.3, 7, 7.1] (D2, D3, D8)

![WagerTransaction states and scenarios](wager-transaction-states.png)

Source of the picture: `wager-transaction-states.svg` (same folder). Thirteen scenarios are drawn from start to end, including the ones that never create a row.

### Decisions

| Decision | Choice | Rejected alternative and why | Consequence |
|---|---|---|---|
| D2 Transitions | `PENDING` to `PENDING_REFERENCE`, `PROCESSED`, `REJECTED` or `FAILED`. `PENDING_REFERENCE` to itself (one retry step), `PROCESSED`, `REJECTED` or `FAILED`. `PROCESSED`, `REJECTED` and `FAILED` are terminal; a transition out of them throws `InvalidTransactionStateError`. `processedAt` is set only on `PROCESSED`. `PENDING` is never stored: it is the in-memory start state inside one SQL transaction | Forbidding the self-transition. It was smaller, but a retry would then change nothing in the object and the retry rule would live outside the domain | The retry is a domain event, so the retry state is domain state (D3) |
| D3 Retry state and limit | `attempts` and `nextAttemptAt` are fields of `WagerTransaction` and columns of the row. `markPendingReference(now)` is the retry step. **3 retries**, no TTL: the first miss schedules a retry at +20 s, a miss then +40 s, a miss then +80 s, a miss after that is `REJECTED` with `REFERENCE_NOT_FOUND`, about 140 s after the first miss. Backoff `20 s * 2^n`, capped at 120 s (the cap never binds with 3 retries) | Keeping the counters only in the row (the domain would not own the rule); a separate retry table (a join and a second write for nothing); 5 attempts with a 10 minute TTL (the TTL could never trigger because the schedule ends at 2.5 minutes) | Two fields beyond the README constructor (listed under "Deviations"). A reference that arrives later than about 2 minutes finds the reversal already rejected; the provider resends with a new key |
| D8 `REJECTED` vs `FAILED` | `REJECTED`: a business rule said no (stored, acked, terminal, committed, never rolled back). `FAILED`: a well-formed message that failed on its last allowed receive; the consumer stores it with `PROCESSING_ERROR`, sends the message to the DLQ and deletes it. Malformed or wallet-less messages never get a row | Defining `FAILED` but never writing it (a dead state, no database trace of poison messages) | A `FAILED` row is terminal and keeps its key, so a DLQ redrive replays `FAILED`; to retry, resubmit with a new key. If storing `FAILED` itself fails (database down), SQS moves the message to the DLQ on its own and only the audit row is lost |

## Concurrency [8, 5.7, 5.8] (D1)

| Decision | Choice | Rejected alternative and why | Consequence |
|---|---|---|---|
| D1 Lock strategy | Pessimistic: `SELECT ... FOR UPDATE` on the wallet row as the first statement of the transaction. The unit of concurrency is the wallet, so wallets run in parallel and there is no global lock. The `UPDATE` also checks `WHERE version = ?` as a second guard, and the schema has `CHECK (balance >= 0)` as the last | **Optimistic `version` + retry:** best when contention is rare, but a hot wallet turns N concurrent writers into about N squared attempts, needs a retry cap, and idempotency needs its own race handling (catch the unique violation). **Atomic conditional `UPDATE`:** the balance rule moves into SQL and bypasses the `Wallet` class, the reference and reversal rules still need reads under a lock, and the row lock is held until commit anyway, so it saves one round trip, not blocking | Everything for one wallet is serialised: the idempotency lookup, the reference lookup, the "already reversed" check and the balance change see a stable state. Cost: a hot wallet queues in Postgres, each waiter holding a connection, so the transaction must stay short and use `lock_timeout` (answer 503 on timeout). Only one lock per transaction (its own wallet), so no deadlocks |

**To validate with data (phase 4, test 15).** One wallet, 200 concurrent small bets with the pool at 10, 60 and 200 connections, against 200 wallets as the baseline. Record total time, throughput, p50/p95/max lock wait, requests that hit `lock_timeout` and whether the pool was exhausted. Expected: slower on the hot wallet but exact. The numbers go here when they exist, with what would trigger a change (for example hot-wallet p95 above target or timeouts under normal load) and the alternative (optimistic with a bounded retry for wallets measured as cold).

## Idempotency [9, 5.2] (D6)

| Decision | Choice | Rejected alternative and why | Consequence |
|---|---|---|---|
| Key | The `Idempotency-Key` header is the source of truth for HTTP, `data.idempotencyKey` for SQS. Any non-empty string up to 255 characters; `provider:externalId` is a recommended default, not enforced | Deriving the key from the body (the README says the header is the source of truth) | The key is looked up after the wallet lock, so the lookup has no race; the unique index is the backstop |
| Uniqueness | `UNIQUE (provider_id, idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` | Only the key. References are resolved by `(provider, externalTransactionId)` (rule 2), which is only meaningful if that pair is unique | Two guarantees in the schema, not in code |
| Payload hash | `sha256` of the canonical JSON (keys sorted, absent optionals omitted) of nine business fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`. The key and transport metadata are not inputs | Hashing the raw body (key order and whitespace would change the hash) | Same key and same hash: replay of the stored result with `idempotentReplay: true`. Same key, different hash: 409, never a replay |
| New key, known external id | Always 409 (`DuplicateExternalTransactionError`), even when the payload matches | Treating the external id as a second dedup key and replaying when the hash matches: friendlier to clients that generate a key per retry, but the key stops being the only source of truth and there are two dedup paths to test | The provider must reuse its key on retry |
| Replay of a pending transaction | Returns the current state of the row (still `PENDING_REFERENCE`, or the final result once the worker resolved it) | | "Original result" (rule 7) applies to terminal states |

## References and reversals [7] (D4, D5, D18)

| Decision | Choice | Rejected alternative and why | Consequence |
|---|---|---|---|
| D4 Rules by kind | `BET` and `OPENING`: no reference. `REFUND` and `ROLLBACK`: reference required. `WIN` and `LOSS`: reference optional, **but if supplied it follows the same rule as a reversal** (must resolve to a `PROCESSED` transaction of an allowed kind with the same provider, player, wallet, currency and round; otherwise it waits per D3 and ends `REJECTED` `REFERENCE_NOT_FOUND`). Allowed referenced kinds: `REFUND` to `BET`; `ROLLBACK` to `BET`, `WIN` or `REFUND`; `WIN` to `BET`; `LOSS` to `BET`. Amount greater than 0 except `LOSS`, which may be 0. `OPENING` is internal and blocked at the API and the consumer, not in the factory | Validate-if-found, never wait (a second code path, and a win can be credited for a bet that never arrives); forbid references on `WIN`/`LOSS` (contradicts the README sentence that a `WIN` may reference the `BET`) | One rule for every kind: if a reference is supplied it must resolve. A `WIN` that arrives before its `BET` is delayed up to about 140 s |
| D5 Rule 4 (no double reversal) | At most one `PROCESSED` reversal (`REFUND` or `ROLLBACK`) per referenced transaction. The second is `REJECTED` `ALREADY_REVERSED`. Enforced by a partial unique index on `reference_transaction_id WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` plus a lookup under the wallet lock | The literal text, "not twice by the same type of operation": one `REFUND` and one `ROLLBACK` per reference would let a `BET` be refunded and rolled back, crediting twice (the eliminatory "credito duplicado") | Stricter than the text, documented as our interpretation as the README asks. A `ROLLBACK` can still undo a `REFUND` by referencing the `REFUND`, which is a different transaction. A `BET` may be referenced by several `WIN`s |
| D18 Reference exists but is not `PROCESSED` | Reference `PENDING_REFERENCE`: the reversal also becomes `PENDING_REFERENCE` and follows the D3 timeline. Reference `REJECTED` or `FAILED`: reject at once with `REFERENCE_NOT_PROCESSED` | Treating every non-`PROCESSED` reference as "not found yet": simpler, but a reversal of a rejected bet would burn 140 s and report a misleading code | One extra branch in the use case |

## Failure codes [7.2] (D7)

Every business refusal is persisted as `REJECTED` with a stable `failureCode`, including currency and player mismatch (audit trail; the alternative was a plain 4xx with no row). A `REJECTED` transaction is terminal and its key is used, so "fix and resend" always means a new key and a new external id.

| Code | When | Provider should |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` larger than the balance | give up on this bet; resending changes nothing until the player has funds |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | a `ROLLBACK` (of a `WIN` or a `REFUND`) would make the balance negative; a `REFUND` or a `ROLLBACK` of a `BET` credit, so they cannot | give up, manual review (README 7 rule 9: a different code from `INSUFFICIENT_FUNDS`) |
| `REFERENCE_NOT_FOUND` | the reference did not arrive within the D3 timeline | send the missing reference first, then resend with a new key and external id |
| `REFERENCE_NOT_PROCESSED` | the reference exists but is `REJECTED` or `FAILED` | give up, nothing was applied that could be reversed |
| `REFERENCE_MISMATCH` | the reference has another provider, player, wallet, currency or round | fix the payload |
| `INVALID_REFERENCE_KIND` | the reference kind is not allowed for this operation (D4) | fix the payload |
| `REVERSAL_AMOUNT_MISMATCH` | the amount differs from the reference (partial reversals are out of scope) | fix the payload |
| `CURRENCY_MISMATCH` | the operation currency differs from the wallet currency | fix the payload |
| `PLAYER_MISMATCH` | the wallet belongs to another player | fix the payload |
| `ALREADY_REVERSED` | the reference already has a processed reversal (D5) | give up, it is already done |
| `PROCESSING_ERROR` | **only on `FAILED`** (D8): well-formed message that failed on its last receive | resubmit with a new key once the fault is fixed |

## HTTP status mapping [9] (D9)

Rule: **status codes describe the request, not the stored state.** The outcome mapping applies to `POST /wagering/transactions`; the GET endpoints return 200 with `status` and `failureCode` in the body for any stored transaction, and 404 only for an unknown id. Every error body has a stable `code` and a `retryable` flag, so a provider never reads a message to decide whether to resend.

| Situation | Status | Stored? |
|---|---|---|
| Invalid body, bad money format, `OPENING` as kind, missing `Idempotency-Key` | 400 | no |
| Unknown wallet or transaction | 404 | no |
| Same key with a different payload; new key with a known external id; duplicate wallet; replay of a `FAILED` transaction | 409 | no (the `FAILED` row already exists) |
| Business rejection (`status: REJECTED`, `failureCode`); a replay returns the same 422 | 422 | yes |
| `PENDING_REFERENCE` | 202 | yes, retried by the worker |
| `PROCESSED`, replays included | 200 (`POST /wallets`: 201) | yes |
| Transient infrastructure failure | 503 with `Retry-After: 1` | no, safe to resend the same request |

Rejected alternative: 200 with `status: REJECTED` in the body (common in wallet APIs, but the provider has to parse the body to tell a rejection from a success, which the README asks to avoid), and applying the POST mapping to GETs (a successful read answering 422 breaks caching and tooling).

## Persistence [4, 5.9, 6.0] (D10, D11, D17)

| Decision | Choice | Rejected alternative and why | Consequence |
|---|---|---|---|
| D10 Money in the database | `numeric(19,2)` + `char(3)`, converted by mapper functions (no custom MikroORM type). Read as a string, never as a JS number. Maximum amount `9999999999999999.99` enforced at the API | `bigint` minor units: no decimal parsing, but it hard-codes 2 decimals in the schema, needs a conversion at every boundary and is not readable in the database | Exact decimal arithmetic and natural `CHECK` constraints in SQL; the reconciliation `SUM` is exact |
| D11 Domain to database | The domain classes never import `@mikro-orm/*` or `@nestjs/*`. `EntitySchema` row classes (`*.schema.ts`) plus mapper functions for inserts and plain reads. **The locking and aggregate queries are plain SQL** through the transactional `EntityManager`: wallet `FOR UPDATE`, outbox and pending-reference `FOR UPDATE SKIP LOCKED`, reconciliation `SUM`. No repository interfaces (one implementation each) | ORM lock modes (hide the lock behind an option and the v7 names are unverified); raw SQL everywhere (the README names MikroORM as the ORM) | The lock is readable in the repository. The boundary is the domain/mapper split, not an interface |
| D17 Ids and clock | `crypto.randomUUID()` (v4), generated by the caller and passed into `create`; the clock is a plain `now: Date` argument. Domain code never calls `randomUUID()` or `new Date()` | UUID v7 via the `uuid` package: time-ordered, one more dependency; random keys fragment the btree a little more, which does not matter here because the ledger has a `bigint seq` for ordering and pagination | Unit tests are deterministic |

## Deviations from the README skeletons

| Where | Deviation | Why |
|---|---|---|
| `WagerTransaction` | Constructor and state gain `attempts` and `nextAttemptAt`; `markPendingReference` takes `now` | The retry is a domain step (D2, D3) |
| `WagerTransaction` | Observed balance for replays (`balance_after`) is a column, not domain state | The domain does not need it; replays must return the balance seen at that moment (7 rule 7) |
| `Wallet` | `createdAt` is public as in the skeleton (the working tree currently has `_createdAt`; rename); `open` does not bump `version`; `openingEntry(...)` builds the `OPENING` ledger entry | README: version is 1 after creation, and the create-wallet example shows version 1 with a balance of 1000.00 |
| Rule 4 | Stricter than the literal text | D5 |


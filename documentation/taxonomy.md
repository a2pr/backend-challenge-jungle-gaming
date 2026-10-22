# Taxonomy

Everything a provider or an operator can see from outside, read from the code (file named in each section). The request list lives in `postman_collection.json` (import it with `postman_environment.json`); this file explains the values, the collection exercises them. Reasons and trade-offs are in `ARCHITECTURE.md`.

## Failure codes (`src/wager/failureCode.ts`)

Stored in `wager_transactions.failure_code`; present exactly when the status is `REJECTED` or `FAILED` (database `CHECK`). "Provider should" is in `ARCHITECTURE.md`, "Failure codes".

| Code | Status | Meaning |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `REJECTED` | `BET` larger than the balance |
| `INSUFFICIENT_FUNDS_FOR_REVERSAL` | `REJECTED` | a `ROLLBACK` would make the balance negative |
| `REFERENCE_NOT_FOUND` | `REJECTED` | the reference did not arrive within the retry timeline (+20 s, +40 s, +80 s) |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` | the reference is `REJECTED` or `FAILED` |
| `REFERENCE_MISMATCH` | `REJECTED` | reference has another provider, player, wallet, currency or round |
| `INVALID_REFERENCE_KIND` | `REJECTED` | reference kind not allowed for this operation |
| `REVERSAL_AMOUNT_MISMATCH` | `REJECTED` | reversal amount differs from the reference |
| `CURRENCY_MISMATCH` | `REJECTED` | operation currency differs from the wallet currency |
| `PLAYER_MISMATCH` | `REJECTED` | wallet belongs to another player |
| `ALREADY_REVERSED` | `REJECTED` | the reference already has a processed reversal |
| `PROCESSING_ERROR` | `FAILED` only | well-formed message that failed on its last receive |

## Transaction statuses and kinds

| Status | Terminal | POST status | Notes |
|---|---|---|---|
| `PENDING` | no | never stored | exists only inside the transaction |
| `PENDING_REFERENCE` | no | 202 | a reversal or `WIN`/`LOSS` waits for its reference; the worker retries |
| `PROCESSED` | yes | 200 | ledger entry written (except `LOSS` and zero-effect kinds) |
| `REJECTED` | yes | 422 | business refusal, stored with a `failureCode` |
| `FAILED` | yes | 409 on replay | `PROCESSING_ERROR` after the last allowed receive |

Kinds a provider may send: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. `OPENING` is internal (wallet creation). GET endpoints answer 200 for any stored row.

## HTTP error codes (`src/http/toHttp.ts`)

Error body: `{status, code, message, retryable, details?}`. `Retry-After: 1` accompanies `TEMPORARILY_UNAVAILABLE`.

| Status | `code` | Retryable | Cause |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | no | bad body, money format, `OPENING` as kind, missing `Idempotency-Key`, non-uuid id, bad cursor or limit |
| 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | no | unknown id |
| 409 | `IDEMPOTENCY_CONFLICT` | no | same key, different payload |
| 409 | `DUPLICATE_EXTERNAL_TRANSACTION` | no | new key, known external id |
| 409 | `DUPLICATE_WALLET` | no | same player and currency |
| 500 | `INVALID_STATE`, `INTERNAL_ERROR` | no | a bug; the message is never shown |
| 503 | `TEMPORARILY_UNAVAILABLE` | yes | lock timeout (5 s), connection loss, any other infrastructure error |
| 4xx/5xx | `HTTP_ERROR` | only 503 | Nest's own errors (unknown route, malformed JSON, failed readiness) |

## Endpoints

| Method and path | Success |
|---|---|
| `POST /wallets` | 201 |
| `GET /wallets/:id`, `GET /wallets/:id/ledger?cursor&limit` (limit capped at 200) | 200 |
| `POST /wallets/:id/reconciliation` | 200, `consistent` true or false; reports, never repairs |
| `POST /wagering/transactions` (header `Idempotency-Key`, optional `x-correlation-id`) | 200 / 202 / 422 / 409, see statuses above |
| `GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 |
| `GET /health/live`, `GET /health/ready` | 200, readiness 503 with `{postgres, sqs}` booleans |
| `GET /metrics` | 200, Prometheus text |

Health and metrics are public; `AuthGuard` (no-op, D15) is on the wallet and wagering controllers.

## Events (`src/events/`, envelope in `integrationEvent.ts`)

Written to `outbox_messages` in the business transaction, published to `wager-events` by the outbox publisher. Envelope: `eventId`, `eventType`, `aggregateId` (always the `walletId`), `correlationId`, `causationId?`, `occurredAt`, `version`, `data`. SQS message attributes: `eventId`, `eventType`. All versions are 1.

| `eventType` | Emitted when | `data` |
|---|---|---|
| `WagerTransactionProcessed` | a transaction reaches `PROCESSED` | walletId, transactionId, kind, status, money, balanceAfter, referenceTransactionId |
| `WagerTransactionRejected` | a transaction reaches `REJECTED` | same, plus failureCode |
| `WagerTransactionPendingReference` | first miss on a reference | walletId, transactionId, kind, referenceExternalTransactionId, nextAttemptAt |
| `WalletBalanceChanged` | a ledger entry is written (also on wallet creation) | walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion |

Delivery is at least once: consumers dedupe by `eventId`. Order is not promised.

## Queues (`localstack/init/ready.d/queues.sh`, `src/messaging/messaging.config.ts`)

| Queue | Type | Env var | Notes |
|---|---|---|---|
| `wager-transactions.fifo` | FIFO | `WAGER_QUEUE_URL` | group id `walletId`, dedup id `messageId`; visibility 30 s; redrive after 5 receives |
| `wager-transactions-dlq.fifo` | FIFO | `WAGER_DLQ_URL` | dead letters, with `errorType`, `errorMessage`, `receiveCount` attributes |
| `wager-events` | standard | `EVENTS_QUEUE_URL` | outbox destination |

Inbound message (`src/messaging/messageSchema.ts`): `{messageId, type: "WagerTransactionRequested", occurredAt, data}` where `data` is the HTTP body plus `idempotencyKey`.

## Metrics (`src/observability/metrics.service.ts`)

`wager_transactions_total{status,kind,failure_code}`, `wager_duplicates_total`, `wager_retries_total{source=consumer|outbox|pending_reference}`, `wager_dlq_total`, `wallet_reconciliation_mismatch_total`, `wallet_lock_wait_seconds` (histogram), `wager_processing_seconds` (histogram), `outbox_lag_seconds` (gauge). Every series carries the label `instance_id` (same value as `instanceId` in the logs; not `instance`, which the scraper adds). The three `wager_retries_total` sources are exported at 0 from start. Meaning of each: `ARCHITECTURE.md`, "Observability".

## Log events (`src/observability/logEvent.ts`)

JSON lines, event name under `message.event`. Fields allowed: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `failureCode`, `source`, `errorType`, `httpStatus`, `method`, `path`, `port`. `logEvent` adds `instanceId` (from `INSTANCE_ID`, default the hostname) to every line by itself.

| Group | Events |
|---|---|
| use case | `wager.processed`, `wager.rejected`, `wager.pending_reference`, `wager.failed`, `wager.replay`, `wager.duplicate_message`, `wager.pending_reference_retry` |
| consumer | `consumer.retry`, `consumer.permanent_failure`, `consumer.dead_lettered`, `consumer.poll_failed`, `consumer.record_failure_failed`, `consumer.dlq_send_failed`, `consumer.delete_failed`, `consumer.release_failed` |
| workers | `outbox.publish_failed`, `outbox.tick_failed`, `pending_reference.reprocess_failed`, `pending_reference.tick_failed` |
| other | `app.started` (port, once), `http.error`, `reconciliation.mismatch` |

## Database tables (`src/migrations/`)

`wallets`, `wager_transactions`, `wallet_ledger_entries` (append-only, trigger), `inbox_messages` (key: consumer name + message id), `outbox_messages`.

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
| SQS client | `@aws-sdk/client-sqs` added; endpoint/region/credentials via `AWS_*` env vars (no config code) | `docker-compose.yaml` |

## Decisions taken so far (to be copied into ARCHITECTURE.md)

- **LocalStack pinned to 4.4.** `latest` and `-pro` abort at startup without `LOCALSTACK_AUTH_TOKEN`. 4.4 runs with no account, so a reviewer can `docker compose up` cold. Cost: no security patches, older SQS emulation.
- **Container runs as `node` (uid 1000).** With the project bind-mounted, a root container left root-owned `dist/` on the host and broke `bun run build`.
- **Readiness probes use the real clients, not HTTP calls to the containers.** Postgres has no HTTP endpoint, and `/_localstack/health` only exists in LocalStack, so it would pass while the app's own SQS config was broken.
- **MikroORM connects lazily**, so `orm.checkConnection()` reports "not established" until the first query. The probe runs an actual query instead.
- **vitest/coverage pinned to ^5.** `^4` crashes npm's resolver (`edgesOut` error). Irrelevant under bun but kept at 5.

## Not done (README requirements still open)

| Area | Points | Gap |
|---|---|---|
| Domain model [6] | 20+10 | No `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`. Domain must not import ORM or Nest decorators, so map via `EntitySchema` |
| Migrations [4] | - | None. Must be versioned and reversible. No migration scripts in `package.json` yet |
| API [9] | - | No wallet or transaction endpoints, no reconciliation endpoint |
| Idempotency, concurrency [7, 8] | 35 | Nothing. Needs persistent dedup, locking strategy (`LockMode` or versioning), multi-instance test |
| SQS consumer, inbox [10] | 15 | Queues `wager-transactions.fifo` and `-dlq.fifo` are not provisioned. No consumer, inbox, retry/DLQ |
| Outbox [11] | - | None. No publish-after-commit |
| Observability [12] | 5 | Only health. No structured logs or metrics |
| Tests [13] | 10 | One placeholder spec, and it currently fails (`app.service.ts` returns `Hello World 5!`). No integration or concurrency tests |
| Postman collection | - | Required by project instructions, missing |
| Docs | 5 | `ARCHITECTURE.md`, `tests.md`, taxonomy file missing. `deployment.md` written |
| Auth [2] | 0 | Not started. README accepts skipping if the decision and extension point (no-op guard/port) are documented |

## Known issues and risks

- `src/app.service.ts` and its spec disagree; `bun run test` fails.
- `health.service.ts` creates its own `SQSClient`. Move to a shared provider when the consumer is added.
- SQS probe checks reachability only; it will not notice a missing queue. Switch to `GetQueueAttributes` once queues exist.
- `.env` holds the DB password and is used by Compose. It is git-ignored; there is no `.env.example` for reviewers yet.
- `DATABASE_URL` ends in `?schema=public` (Prisma style). Ignored by the driver; set `schema` in the MikroORM config if a non-default schema is wanted.
- No `healthcheck`/`condition: service_healthy` in Compose, so the app can start before Postgres accepts connections. Readiness covers this at runtime, but the first MikroORM query may race at boot.
- `tests.md` and the coverage target for the 80% goal are untracked.

## Suggested next steps (smallest path to the scoring weight)

1. `Money` value object + unit tests (eliminatory rules: no `number`).
2. `Wallet` / ledger schemas + first migration, with up/down scripts.
3. Submit-transaction use case with persistent idempotency key and row lock; concurrency test against real Postgres.
4. Provision queues (LocalStack init script), then inbox/outbox and consumer.
5. Fill `ARCHITECTURE.md` from the decisions above as each lands.

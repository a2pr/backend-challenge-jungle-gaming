# Deployment

Everything runs through Docker Compose. Only the local/dev setup exists today; the production notes at the end are considerations, not implemented.

## Prerequisites

- Docker with the Compose plugin
- bun >= 1.4 (only for running scripts/tests on the host; the containers install their own)
- Free host ports: 3000 (API), 5432 (Postgres), 4566 and 4510-4559 (LocalStack, bound to 127.0.0.1); 3001, 3002 for the manual multi-instance check and 3101 and up for `bun run test:multi`

## Environment

Compose reads `.env` in the project root. It must define:

| Variable | Example | Used by |
|---|---|---|
| `DATABASE_HOST` | `nest-postgres` | also sets the Postgres container name |
| `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME` | `root` / `…` / `nest` | Postgres init |
| `DATABASE_PORT` | `5432` | URL below |
| `DATABASE_URL` | `postgresql://USER:PASS@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}` | MikroORM (`clientUrl`) |
| `LOCALSTACK_DOCKER_NAME` | `localstack` | optional, defaults to `localstack-main` |

SQS settings are fixed in `docker-compose.yaml` (`AWS_ENDPOINT_URL_SQS=http://localstack:4566`, region `us-east-1`, dummy credentials `test`/`test`). Do not commit `.env`.

## Start

```bash
docker compose up -d --build
```

Services:

| Service | Image | Notes |
|---|---|---|
| `nest-app` | built from `Dockerfile` (node:22 + bun) | runs `bun run start:dev`, source bind-mounted, reloads on save, runs as uid 1000 |
| `db` | `postgres:13` | data in volume `postgres-data` |
| `localstack` | `localstack/localstack:4.4` | `SERVICES=sqs`, data in volume `localstack-data` |

## Verify

```bash
curl -i localhost:3000/health/live    # 200 OK
curl -i localhost:3000/health/ready   # 200 {"postgres":true,"sqs":true}
```

`/health/ready` returns 503 with the failing dependency set to `false` if Postgres or SQS cannot be reached within 2 s.

## Operations

```bash
docker compose logs -f nest-app
docker compose stop db            # readiness -> 503, restart it and it recovers without restarting the app
docker compose down               # keep data
docker compose down -v            # also wipe Postgres and LocalStack volumes
```

**Stopping the app.** `docker compose stop nest-app` sends `SIGTERM`; the consumer finishes the message it is handling (it commits and is deleted), hands the unstarted ones back to the queue at once, and the process exits. Idle it takes under a second; mid-message it waits for the commit (at most the 5 s lock timeout). The exit code is 143: Nest re-raises the signal after shutting down, which is the normal graceful exit. Docker's default 10 s grace period is enough (do not set it below the 5 s lock timeout plus a commit) so `SIGKILL` never cuts a commit; a hard kill is still safe (the message is redelivered and the inbox dedupes it), only slower.

**After changing dependencies**, recreate the anonymous `node_modules` volume or the container keeps the old one and fails with `Cannot find module`:

```bash
docker compose up -d --build -V nest-app
```

## Running several instances

Correctness does not depend on the instance count (`ARCHITECTURE.md`, "Multi-instance correctness"). Two ways to see it.

**Automated, three real processes:** `docker compose up -d db localstack`, then `bun run test:multi` (`tests.md`, "Multi-instance tests"). The test starts the instances on the host and uses throwaway queues; the `nest-app` container is not needed.

**By hand, three containers against the compose stack.** `docker-compose.yaml` publishes a fixed `3000:3000`, so `--scale nest-app=3` fails on the port; extra instances are started with `docker compose run`, each with its own host port and the compiled `dist/` (not `start:dev`: several watchers would each delete and rebuild `dist/`):

```bash
docker compose up -d --build                      # instance 1, :3000 (dist/ is built by its watcher)
docker compose run -d --no-deps --name app-2 -p 3001:3000 nest-app node dist/main.js
docker compose run -d --no-deps --name app-3 -p 3002:3000 nest-app node dist/main.js
for p in 3000 3001 3002; do curl -s -o /dev/null -w "$p %{http_code}\n" localhost:$p/health/ready; done   # 200 x3
```

All three share the `nest` database and the compose queues, and all three run the consumer and the publishers. Then race one wallet from the host, spreading the calls over the ports:

```bash
PID=$(cat /proc/sys/kernel/random/uuid)
W=$(curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' \
    -d "{\"playerId\":\"$PID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | sed 's/.*"id":"\([^"]*\)".*/\1/')
ports=(3000 3001 3002)
for i in $(seq 1 30); do
  U=$(cat /proc/sys/kernel/random/uuid)
  curl -s -o /dev/null -w "%{http_code}\n" -XPOST localhost:${ports[$((i%3))]}/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: man-$U" \
    -d "{\"providerId\":\"p\",\"externalTransactionId\":\"e-$U\",\"playerId\":\"$PID\",\"walletId\":\"$W\",\"roundId\":\"r\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}" &
done | sort | uniq -c
curl -s -XPOST localhost:3001/wallets/$W/reconciliation     # consistent: true, stored 0.00
docker rm -f app-2 app-3                                     # clean up
```

Expected (tried 2026-10-21): `10 200` and `20 422`, reconciliation `consistent: true`, balance `0.00`, 11 ledger entries (opening credit plus 10 debits). To see a restart, `docker kill app-2` in the middle of a send loop and start it again; the outbox and the queue drain on the remaining instances.

Production notes: run migrations once as a release step before starting several instances; give each instance the same `DATABASE_URL` and queue URLs; keep `DATABASE_POOL_MAX` times the instance count under Postgres `max_connections`.

## Database migrations

The schema is a hand-written SQL migration in `src/migrations/` (triggers, partial indexes and cross-column checks are not generated by the schema tool). It is applied by a small runner, `src/migrate.ts`, which is compiled to `dist/migrate.js`. The app never migrates on boot.

```bash
# inside the container (it already has DATABASE_URL); dist/ must be built, `start:dev` keeps it current
docker compose exec nest-app bun run migration:status   # lists pending migrations
docker compose exec nest-app bun run migration:up       # applies all pending
docker compose exec nest-app bun run migration:down     # reverts the LAST migration only
```

- On the host, `bun run build` first, then `bun run migration:up`. The scripts run under bun (not `node`) on purpose: bun reads `.env` and expands its `${...}` values, while plain `node` sees no `DATABASE_URL` and fails with `No database specified`.
- Applied migrations are recorded in the `mikro_orm_migrations` table; running `up` twice is a no-op.
- Inside Compose the app reaches Postgres at host `db`: `docker-compose.yaml` builds `DATABASE_URL` for `nest-app` itself, because `.env` uses `localhost` for commands run from the host (tests, migrations). A fresh database has no tables until `migration:up` runs; until then every wallet request answers 503.
- `down` drops the tables and data. It exists for development and the `up, down, up` test, not for production rollbacks.
- Integration tests build their own schema in the `${DATABASE_NAME}_test` database (`bun run test:e2e`), so they never touch the dev database.
- Migration files are named `Migration<yyyyMMddHHmmss>_<name>.ts`. Keep the timestamp prefix: files are applied in name order.

## Known problems

- **LocalStack auth token.** `localstack/localstack:latest` and `-pro` exit with code 55 (`License activation failed`) without `LOCALSTACK_AUTH_TOKEN`. The compose file pins 4.4 to avoid this. To use a current image, create a free account, put the token in `.env`, and pass `LOCALSTACK_AUTH_TOKEN: ${LOCALSTACK_AUTH_TOKEN}` to the service.
- **Root-owned files on the host.** If `dist/` or `tsconfig.build.tsbuildinfo` become root-owned (container run as root), `bun run build` fails with `EACCES`. Remove with `docker run --rm -v "$PWD":/app alpine rm -rf /app/dist /app/tsconfig.build.tsbuildinfo`.
- **Boot race.** There are no Compose `healthcheck`s yet, so `nest-app` can start before Postgres accepts connections.
- **No queues.** `wager-transactions.fifo` and `wager-transactions-dlq.fifo` are not created. The SQS probe only checks reachability.

## Production considerations (not implemented)

- The current `Dockerfile` is dev-only (`start:dev`, bind mount, dev dependencies). Production needs a multi-stage build, `bun install --production`, `node dist/main`, and no bind mount.
- Replace LocalStack with real SQS: drop `AWS_ENDPOINT_URL_SQS` and the dummy keys, use an IAM role; `new SQSClient()` already reads them from the environment.
- Run migrations as a separate release step (job), not on app boot, since several instances start together.
- Postgres: managed instance, secrets from a secret manager instead of `.env`, `postgres:13` is near end of life, move to a supported major.
- Point the orchestrator's liveness probe at `/health/live` and readiness at `/health/ready`.
- Graceful shutdown (`app.enableShutdownHooks()`) is not enabled; the README expects in-flight SQS messages to be handled on shutdown.

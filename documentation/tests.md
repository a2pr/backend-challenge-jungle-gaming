# Tests

Two vitest configs, one database. `bun` must be on PATH; if it is not, prefix the commands with `bunx` as below.

| Command | What runs | Needs |
|---|---|---|
| `bun run test` | unit specs: `src/**/*.spec.ts`, `test/unit/**` (domain, events, errors, domain purity) | nothing |
| `bun run test:e2e` | `test/integration/**` and `test/e2e/**` against real Postgres | `docker compose up -d db` (Postgres on 5432) and `DATABASE_URL_TEST` in `.env` |
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

Current state (2026-10-21): 291 unit, 91 integration and e2e, three green runs in a row.

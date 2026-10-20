# Architecture decisions

Decisions taken so far, section numbers refer to `README.md`. Infrastructure decisions (LocalStack pin, container user, readiness probes, lazy MikroORM connection) are in `progress-log.md` and will be moved here as each area is implemented.

## Money value object [6.1, 5.1]

Code: `src/money/Money.ts`, DTO `src/money/dto/money.props.dto.ts`, tests `test/money/money.spec.ts`.

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

import {MikroORM} from '@mikro-orm/postgresql';

// One statement, so wallet balance and ledger sum come from the same snapshot.
// The same query backs the phase 5 reconciliation endpoint.
const LEDGER_QUERY = `
    SELECT w.balance::text AS balance,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS ledger_balance,
           COUNT(l.id)::int AS entries
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    WHERE w.id = ? GROUP BY w.id`;

// The final invariant of every test: wallet.balance == balance rebuilt from the ledger.
export async function assertLedgerMatchesBalance(orm: MikroORM, walletId: string) {
    const rows = await orm.em.getConnection().execute(LEDGER_QUERY, [walletId]);
    expect(rows, `wallet ${walletId} not found`).toHaveLength(1);
    const {balance, ledger_balance: ledgerBalance, entries} = rows[0];
    expect({balance, entries}, `ledger (${entries} entries) rebuilds ${ledgerBalance}`).toMatchObject({balance: ledgerBalance});
}

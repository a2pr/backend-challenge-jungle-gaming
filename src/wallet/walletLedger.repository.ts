import {Injectable} from "@nestjs/common";
import {EntityManager} from "@mikro-orm/core";
import WalletLedgerEntry from "./walletLedgerEntry.js";
import {WalletLedgerEntryRow} from "./walletLedgerEntry.schema.js";
import {toRow} from "./walletLedgerEntry.mapper.js";

@Injectable()
export class WalletLedgerRepository {
    // The table is append-only (DB trigger), so there is no update path.
    async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
        await em.insert(WalletLedgerEntryRow, toRow(entry));
    }

    // Balance rebuilt from the ledger, as a numeric string. Compare it with wallets.balance for reconciliation.
    async sumByWallet(em: EntityManager, walletId: string): Promise<{ ledgerBalance: string; entries: number }> {
        const rows = await em.getConnection().execute(
            `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS ledger_balance,
                    COUNT(*)::int AS entries
             FROM wallet_ledger_entries WHERE wallet_id = ?`,
            [walletId],
            'all',
            em.getTransactionContext(), // join the caller's transaction, not another pool connection
        );
        return {ledgerBalance: rows[0].ledger_balance, entries: rows[0].entries};
    }

    // Cursor page: `afterSeq` is the last seq the client saw (0 for the first page). Returns up to `limit` rows;
    // the caller asks for limit + 1 to learn whether another page exists. `seq` is a read-model column only
    // (GENERATED ALWAYS), so it is not mapped into the domain entry.
    async page(em: EntityManager, walletId: string, afterSeq: number, limit: number): Promise<LedgerPageRow[]> {
        const rows = await em.getConnection().execute(
            `SELECT seq::text AS seq_text, id, transaction_id, direction, amount::text AS amount, currency,
                    balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
             FROM wallet_ledger_entries
             WHERE wallet_id = ? AND seq > ?
             ORDER BY seq                 -- the input column: the output is aliased seq_text, so this never sorts as text
             LIMIT ?`,
            [walletId, afterSeq, limit],
            'all',
            em.getTransactionContext(),
        );
        return rows.map((r: any) => ({
            seq: Number(r.seq_text),      // bigint comes back as text; far below 2^53
            id: r.id,
            transactionId: r.transaction_id,
            direction: r.direction,
            amount: r.amount,
            currency: r.currency,
            balanceBefore: r.balance_before,
            balanceAfter: r.balance_after,
            createdAt: new Date(r.created_at),   // raw SQL may return the timestamptz as text
        }));
    }

    // Stored balance and the balance rebuilt from the ledger, from ONE statement (one snapshot, no lock). Two
    // statements could see different snapshots under concurrent writes and report a false mismatch. The difference
    // is computed by Postgres on numeric, so it can be negative and never passes through a JS number.
    async reconcile(em: EntityManager, walletId: string): Promise<Reconciliation | null> {
        const rows = await em.getConnection().execute(
            `SELECT w.currency,
                    w.balance::text AS stored_balance,
                    COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS ledger_balance,
                    (w.balance - COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0))::numeric(19,2)::text AS difference,
                    COUNT(l.id)::int AS entries
             FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
             WHERE w.id = ? GROUP BY w.id`,
            [walletId],
            'all',
            em.getTransactionContext(),
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {currency: r.currency, storedBalance: r.stored_balance, ledgerBalance: r.ledger_balance, difference: r.difference, entries: r.entries};
    }
}

export interface LedgerPageRow {
    seq: number;
    id: string;
    transactionId: string;
    direction: string;
    amount: string;
    currency: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: Date;
}

export interface Reconciliation {
    currency: string;
    storedBalance: string;
    ledgerBalance: string;
    difference: string;
    entries: number;
}

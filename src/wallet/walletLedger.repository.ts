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
}

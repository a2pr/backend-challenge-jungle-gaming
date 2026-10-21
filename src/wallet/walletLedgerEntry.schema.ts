import {EntitySchema} from "@mikro-orm/core";
import {LedgerDirection} from "./walletLedgerEntry.js";

// Mirrors wallet_ledger_entries. Append-only: the DB trigger rejects UPDATE/DELETE, so only ever persist new rows.
// `seq` (GENERATED ALWAYS identity) is left out so inserts never try to set it; map it read-only when pagination needs it.
export class WalletLedgerEntryRow {
    id!: string;
    walletId!: string;
    transactionId!: string;
    direction!: LedgerDirection;
    amount!: string;          // numeric(19,2) as string (D10)
    currency!: string;
    balanceBefore!: string;
    balanceAfter!: string;
    createdAt!: Date;
}

// Column names come from the default naming strategy (camelCase -> snake_case).
export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
    class: WalletLedgerEntryRow,
    tableName: 'wallet_ledger_entries',
    properties: {
        id: {type: 'uuid', primary: true},
        walletId: {type: 'uuid'},
        transactionId: {type: 'uuid'},
        direction: {type: 'string'},
        amount: {type: 'string', columnType: 'numeric(19,2)'},
        currency: {type: 'string', columnType: 'char(3)'},
        balanceBefore: {type: 'string', columnType: 'numeric(19,2)'},
        balanceAfter: {type: 'string', columnType: 'numeric(19,2)'},
        createdAt: {type: 'Date', columnType: 'timestamptz'},
    }
})

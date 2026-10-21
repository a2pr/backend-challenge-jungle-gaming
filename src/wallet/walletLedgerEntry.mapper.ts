import {WalletLedgerEntryRow} from "./walletLedgerEntry.schema.js";
import WalletLedgerEntry from "./walletLedgerEntry.js";
import Money from "../money/money.js";

export function toDomain(row: WalletLedgerEntryRow): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.walletId,
        transactionId: row.transactionId,
        direction: row.direction,
        money: Money.from({amount: row.amount, currency: row.currency}),
        balanceBefore: Money.from({amount: row.balanceBefore, currency: row.currency}),
        balanceAfter: Money.from({amount: row.balanceAfter, currency: row.currency}),
        createdAt: row.createdAt,
    })
}

export function toRow(walletLedgerEntry: WalletLedgerEntry): WalletLedgerEntryRow {
    return Object.assign(new WalletLedgerEntryRow(), {
        id: walletLedgerEntry.id,
        walletId: walletLedgerEntry.walletId,
        transactionId: walletLedgerEntry.transactionId,
        direction: walletLedgerEntry.direction,
        amount: walletLedgerEntry.money.toString(),
        currency: walletLedgerEntry.money.currency,
        balanceBefore: walletLedgerEntry.balanceBefore.toString(),
        balanceAfter: walletLedgerEntry.balanceAfter.toString(),
        createdAt: walletLedgerEntry.createdAt,
    })
}

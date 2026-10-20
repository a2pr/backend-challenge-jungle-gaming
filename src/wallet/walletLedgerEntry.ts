import Money from "../money/money.js";

export enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }

// todo: shapes undecided, see progress-log.md
type CreateLedgerEntryProps = unknown;
type LedgerEntryState = unknown;

export default class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) {}

    static create(_props: CreateLedgerEntryProps): WalletLedgerEntry { throw new Error("not implemented"); }
    static rehydrate(_state: LedgerEntryState): WalletLedgerEntry { throw new Error("not implemented"); }

    /** balanceBefore ± money === balanceAfter. Verificada na factory. */
    isBalanced(): boolean { throw new Error("not implemented"); }
}
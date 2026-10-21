import Money from "../money/money.js";
import {CurrencyMismatchError} from "../money/errors.js";
import {InvalidMovementError} from "./errors.js";

export enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }

// todo: shapes undecided, see progress-log.md
export interface CreateLedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    now: Date;
}

export interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

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
    ) {
    }

    static create(_props: CreateLedgerEntryProps): WalletLedgerEntry {
        if (new Set([_props.money.currency, _props.balanceBefore.currency, _props.balanceAfter.currency]).size !== 1) {
            throw new InvalidMovementError(`Invalid currency ${_props.balanceAfter.currency}`)
        }

        if (!_props.money.isPositive()) {
            throw new InvalidMovementError(`money is negative`)
        }
        if (_props.balanceBefore.isNegative() || _props.balanceAfter.isNegative()) {
            throw new InvalidMovementError(`balance before or after is negative`)
        }

        let entry = new WalletLedgerEntry(
            _props.id,
            _props.walletId,
            _props.transactionId,
            _props.direction,
            _props.money,
            _props.balanceBefore,
            _props.balanceAfter,
            _props.now
        )
        if (!entry.isBalanced()) {
            throw new InvalidMovementError(`ENtry is not balanced`)
        }
        return entry
    }

    static rehydrate(_state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            _state.id,
            _state.walletId,
            _state.transactionId,
            _state.direction,
            _state.money,
            _state.balanceBefore,
            _state.balanceAfter,
            _state.createdAt
        )
    }

    /** balanceBefore ± money === balanceAfter. Verificada na factory. */
    isBalanced(): boolean {
        const sum = this.direction == LedgerDirection.Credit
            ? this.balanceBefore.add(this.money)
            : this.balanceBefore.subtract(this.money);

        return sum.equals(this.balanceAfter)
    }
}
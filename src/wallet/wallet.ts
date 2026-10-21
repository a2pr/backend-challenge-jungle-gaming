import Money from '../money/money.js';
import {InsufficientFundsError, InvalidMovementError} from "./errors.js";
import {CurrencyMismatchError} from "../money/errors.js";
import {LedgerDirection} from "./walletLedgerEntry.js";
import WalletLedgerEntry from "./walletLedgerEntry.js";

export interface WalletState {
    id: string,
    playerId: string,
    currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date
}

interface MovementContext {
    entryId: string;
    transactionId: string;
    now: Date
}


export default class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) {
    }

    static open(props: {
        id: string;
        playerId: string;
        initialBalance: Money;
        now: Date
    }): Wallet {

        if (props.initialBalance.isNegative()) {
            throw new InvalidMovementError(`Wallet cannot start in the negative`)
        }

        return new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            props.now,
            props.now
        );
    }

    openingEntry(ctx: MovementContext): WalletLedgerEntry | undefined {
        if (this._version !== 1) throw new Error('opening entry only exists for a new wallet');
        if (this._balance.isZero()) return undefined;              // nothing to record
        return WalletLedgerEntry.create({
            id: ctx.entryId, walletId: this.id, transactionId: ctx.transactionId,
            direction: LedgerDirection.Credit, money: this._balance,
            balanceBefore: Money.zero(this.currency), balanceAfter: this._balance, now: ctx.now,
        });
    }

    /** Reconstrução a partir da persistência — não revalida transições. */
    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            state.createdAt,
            state.updatedAt
        );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }

    // Aplicam a movimentação mantendo saldo e ledger consistentes entre si.
    // Assinatura e retorno são decisão sua.
    // 1 assertSameCurrency(money)            -> CurrencyMismatchError
    // 2 money.isPositive()                   -> else InvalidMovementError
    // 3 after = balance.subtract / add(money)
    // 4 after.isNegative()                   -> InsufficientFundsError(balance, money)   (debit only)
    // 5 entry = WalletLedgerEntry.create({ walletId: this.id, transactionId: ctx.transactionId,
    //        id: ctx.entryId, direction, money, balanceBefore: this._balance, balanceAfter: after, now: ctx.now })
    // 6 this._balance = after; this._updatedAt = ctx.now; this._version += 1      <- only now
    // 7 return entry
    debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
        // returns WalletLedgerEntry
        this.assertSameCurrency(money)
        if (money.isNegative()) {
            throw new InvalidMovementError('no negative values')
        }
        let after = this.balance.subtract(money)

        if (after.isNegative()) {
            throw new InsufficientFundsError(this.balance, money)
        }

        let entry = WalletLedgerEntry.create({
            id: ctx.entryId,
            walletId: this.id,
            transactionId: ctx.transactionId,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: this._balance,
            balanceAfter: after,
            now: ctx.now
        })

        this._balance = after
        this._updatedAt = ctx.now
        this._version += 1
        return entry
    }

    credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
        // returns WalletLedgerEntry
        this.assertSameCurrency(money)
        if (money.isNegative()) {
            throw new InvalidMovementError('no negative values')
        }

        let after = this.balance.add(money)
        let entry = WalletLedgerEntry.create({
            id: ctx.entryId,
            walletId: this.id,
            transactionId: ctx.transactionId,
            direction: LedgerDirection.Credit,
            money,
            balanceBefore: this._balance,
            balanceAfter: after,
            now: ctx.now
        })

        this._balance = after
        this._updatedAt = ctx.now
        this._version += 1
        return entry
    }


    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }
}

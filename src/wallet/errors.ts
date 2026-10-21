import Money from "../money/money.js";

export class InvalidMovementError extends Error{}
export class InsufficientFundsError extends Error{
    constructor(public readonly balance:Money, public readonly requested: Money) {
        super(`Insufficient funds: balance ${balance}, requested ${requested}`);

        this.name = "InsufficientFundsError";
        Object.setPrototypeOf(this, InsufficientFundsError.prototype);
    }
}
export class DuplicateWalletError extends Error{
    constructor(public readonly playerId: string, public readonly currency: string) {
        super(`Wallet already exists for player ${playerId} in ${currency}`);

        this.name = "DuplicateWalletError";
        Object.setPrototypeOf(this, DuplicateWalletError.prototype);
    }
}

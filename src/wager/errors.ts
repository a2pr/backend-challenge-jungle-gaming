import {WagerTransactionStatus} from "./wagerTransactionStatus.js";

class InvalidWagerTransactionError extends Error{
    constructor(message: string) {
        super(message);

        this.name = "InvalidWagerTransactionError";
        Object.setPrototypeOf(this, InvalidWagerTransactionError.prototype);
    }
}

class InvalidTransactionStateError extends Error {
    constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
        super(`Cannot go from ${from} to ${to} status`);
        this.name = "InvalidTransactionStateError";
        Object.setPrototypeOf(this, InvalidTransactionStateError.prototype);
    }
}
export {InvalidWagerTransactionError, InvalidTransactionStateError}
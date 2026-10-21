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

class WalletNotFoundError extends Error {
    constructor(public readonly walletId: string) {
        super(`Wallet ${walletId} not found`);
        this.name = "WalletNotFoundError";
        Object.setPrototypeOf(this, WalletNotFoundError.prototype);
    }
}

class IdempotencyConflictError extends Error {
    constructor(public readonly providerId: string, public readonly idempotencyKey: string) {
        super(`Idempotency key ${idempotencyKey} was already used for a different request`);
        this.name = "IdempotencyConflictError";
        Object.setPrototypeOf(this, IdempotencyConflictError.prototype);
    }
}

class DuplicateExternalTransactionError extends Error {
    constructor(public readonly providerId: string, public readonly externalTransactionId: string) {
        super(`External transaction ${externalTransactionId} was already received under another key`);
        this.name = "DuplicateExternalTransactionError";
        Object.setPrototypeOf(this, DuplicateExternalTransactionError.prototype);
    }
}

export {
    InvalidWagerTransactionError, InvalidTransactionStateError,
    WalletNotFoundError, IdempotencyConflictError, DuplicateExternalTransactionError,
}

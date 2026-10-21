import {HttpException} from "@nestjs/common";
import {DuplicateWalletError, InvalidMovementError} from "../wallet/errors.js";
import {CurrencyMismatchError, InvalidMoneyError} from "../money/errors.js";
import {
    DuplicateExternalTransactionError,
    IdempotencyConflictError, InvalidTransactionStateError,
    InvalidWagerTransactionError,
    TransactionNotFoundError,
    WalletNotFoundError
} from "../wager/errors.js";
import {BadRequestError} from "./errors.js";

export interface HttpFailure {
    status: number;
    code: string;               // stable machine string, never the exception message
    message: string;
    retryable: boolean;         // the provider can resend the same request unchanged
    headers?: Record<string, string>;
    details?: unknown;
}

const fail = (status: number, code: string, message: string, retryable = false): HttpFailure =>
    ({status, code, message, retryable});

// Postgres lock_timeout is 55P03. The driver error may be wrapped, so walk the cause chain.
function hasPgCode(error: unknown, code: string): boolean {
    for (let e: any = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
        if (e.code === code) return true;
    }
    return false;
}

// D9. Business refusals (insufficient funds, bad reference) are not errors: they come back as REJECTED and
// transactionResponse answers 422, so they never reach this function.
export function toHttp(error: unknown): HttpFailure {
    switch (true) {
        case error instanceof BadRequestError:
            return {...fail(400, 'VALIDATION_ERROR', error.message), details: error.details}
        case error instanceof InvalidMoneyError:
        case error instanceof CurrencyMismatchError:
        case error instanceof InvalidWagerTransactionError:
        case error instanceof InvalidMovementError:
            return fail(400, 'VALIDATION_ERROR', error.message)
        case error instanceof WalletNotFoundError:
            return fail(404, 'WALLET_NOT_FOUND', error.message)
        case error instanceof TransactionNotFoundError:
            return fail(404, 'TRANSACTION_NOT_FOUND', error.message)
        case error instanceof IdempotencyConflictError:
            return fail(409, 'IDEMPOTENCY_CONFLICT', error.message)
        case error instanceof DuplicateExternalTransactionError:
            return fail(409, 'DUPLICATE_EXTERNAL_TRANSACTION', error.message)
        case error instanceof DuplicateWalletError:
            return fail(409, 'DUPLICATE_WALLET', error.message)
        case error instanceof InvalidTransactionStateError:
            return fail(500, 'INVALID_STATE', 'Internal error')       // a bug: logged by the filter, not shown
        case error instanceof HttpException:
            // Nest's own errors (unknown route, malformed JSON body): keep their status.
            return fail(error.getStatus(), 'HTTP_ERROR', error.message)
        case hasPgCode(error, '55P03'):
        case error instanceof Error:
            // Lock timeout, connection loss, timeouts: transient, the same request can be retried (D9).
            return {...fail(503, 'TEMPORARILY_UNAVAILABLE', 'Temporarily unavailable', true), headers: {'Retry-After': '1'}}
        default:
            // A non-Error throw is a programming mistake; retrying will not help.
            return fail(500, 'INTERNAL_ERROR', 'Internal error')
    }
}

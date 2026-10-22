import {ZodError} from "zod";
import {CurrencyMismatchError, InvalidMoneyError} from "../money/errors.js";
import {InvalidMovementError} from "../wallet/errors.js";
import {
    DuplicateExternalTransactionError, IdempotencyConflictError,
    InvalidWagerTransactionError, WalletNotFoundError,
} from "../wager/errors.js";
import {InboxPayloadMismatchError} from "./errors.js";

export type ErrorBucket = 'permanent' | 'transient'

// Only called from the consumer's catch: a business rejection is a normal return, never an exception.
// permanent: the provider must fix and resend, a retry cannot help -> DLQ now.
// transient (default): a wrong "transient" only retries, a wrong "permanent" sends a good message to the DLQ.
// Separate from toHttp on purpose: same classes, different action (ack/retry/DLQ instead of a status).
export function classify(error: unknown): ErrorBucket {
    switch (true) {
        case error instanceof ZodError:
        case error instanceof SyntaxError:      // JSON.parse on the body
        case error instanceof InvalidMoneyError:
        case error instanceof CurrencyMismatchError:
        case error instanceof InvalidWagerTransactionError:
        case error instanceof InvalidMovementError:
        case error instanceof IdempotencyConflictError:
        case error instanceof DuplicateExternalTransactionError:
        case error instanceof WalletNotFoundError:
        case error instanceof InboxPayloadMismatchError:
            return 'permanent'
        default:
            return 'transient'
    }
}

import {WagerTransactionStatus} from "../wager/wagerTransactionStatus.js";
import {FailureCode} from "../wager/failureCode.js";
import MoneyProps from "../money/dto/money.props.dto.js";
import {WagerResult} from "../wager/SubmitWagerTransaction.usecase.js";
import type {StoredWager} from "../wager/wagerTransaction.repository.js";

export interface TransactionBody {
    transactionId: string;
    status: WagerTransactionStatus;
    failureCode?: FailureCode;
    balance: MoneyProps;
    idempotentReplay: boolean
}

// Shared with the GETs (step 4).
export function toBody(result: WagerResult): TransactionBody {
    return {
        transactionId: result.transactionId,
        status: result.status,
        ...(result.failureCode ? {failureCode: result.failureCode} : {}),
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
    };
}

// POST only: the GETs of step 4 reuse toBody and always answer 200 for a stored row.
export function toResponse(result: WagerResult): { status: number; body: TransactionBody } {
    const status = ({
        [WagerTransactionStatus.Processed]: 200,
        [WagerTransactionStatus.PendingReference]: 202,
        [WagerTransactionStatus.Rejected]: 422,
        [WagerTransactionStatus.Failed]: 409,
    } as Record<string, number>)[result.status];
    if (status === undefined) throw new Error(`no HTTP status for ${result.status}`);   // PENDING is never stored
    return {status, body: toBody(result)};
}

// GET body: a stored row, whatever its status, is a 200 (the controller never calls toResponse for reads).
// `balance` is the balance after this transaction, as the POST showed, not the wallet's current balance.
export function toStoredBody({transaction, balanceAfter}: StoredWager): TransactionBody {
    // every insert writes balanceAfter, so null is a bug, not a request error
    if (balanceAfter === null) throw new Error(`Transaction ${transaction.id} has no balanceAfter`);
    return toBody({
        kind: 'completed',
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: {amount: balanceAfter, currency: transaction.money.currency},
        idempotentReplay: false,
    });
}

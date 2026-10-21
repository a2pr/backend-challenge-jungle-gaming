import {EventContext, IntegrationEvent} from "./integrationEvent.js";
import WagerTransaction from "../wager/wagerTransaction.js";
import Money from "../money/money.js";
import MoneyProps from "../money/dto/money.props.dto.js";
import {FailureCode} from "../wager/failureCode.js";
import {WagerTransactionKind} from "../wager/wagerTransactionKind.js";
import {WagerTransactionStatus} from "../wager/wagerTransactionStatus.js";

interface WagerTransactionRejectedData {
    walletId: string;
    transactionId: string;
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    money: MoneyProps;
    balanceAfter: MoneyProps;
    referenceTransactionId: string | undefined;
    failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
    readonly eventType = "WagerTransactionRejected";
    readonly version = 1;

    // balanceAfter is the balance observed when the rejection was decided (the wallet did not move).
    static from(wager: WagerTransaction, balanceAfter: Money, ctx: EventContext): WagerTransactionRejected {
        if (!wager.failureCode) throw new Error('rejected transaction has no failure code');   // caller bug
        return new WagerTransactionRejected({
            ...ctx,
            aggregateId: wager.walletId,
            data: {
                walletId: wager.walletId,
                transactionId: wager.id,
                kind: wager.kind,
                status: wager.status,
                money: wager.money.toJSON(),           // MoneyProps strings, never Money instances
                balanceAfter: balanceAfter.toJSON(),
                referenceTransactionId: wager.referenceTransactionId,
                failureCode: wager.failureCode,
            },
        })
    }
}

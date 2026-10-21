import {EventContext, IntegrationEvent} from "./integrationEvent.js";
import WagerTransaction from "../wager/wagerTransaction.js";
import Money from "../money/money.js";
import MoneyProps from "../money/dto/money.props.dto.js";
import {WagerTransactionKind} from "../wager/wagerTransactionKind.js";
import {WagerTransactionStatus} from "../wager/wagerTransactionStatus.js";

interface WagerTransactionProcessedData {
    walletId: string;
    transactionId: string;
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    money: MoneyProps;
    balanceAfter: MoneyProps;
    referenceTransactionId: string | undefined;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
    readonly eventType = "WagerTransactionProcessed";
    readonly version = 1;

    // balanceAfter is not domain state (it is a column), so the caller passes the balance it observed.
    static from(wager: WagerTransaction, balanceAfter: Money, ctx: EventContext): WagerTransactionProcessed {
        return new WagerTransactionProcessed({
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
            },
        })
    }
}

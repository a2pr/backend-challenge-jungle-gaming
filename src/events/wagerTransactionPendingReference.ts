import {EventContext, IntegrationEvent} from "./integrationEvent.js";
import WagerTransaction from "../wager/wagerTransaction.js";
import {WagerTransactionKind} from "../wager/wagerTransactionKind.js";

interface WagerTransactionPendingReferenceData {
    walletId: string;
    transactionId: string;
    kind: WagerTransactionKind;
    referenceExternalTransactionId: string;   // the provider's id we are still waiting for
    nextAttemptAt: string;                    // ISO-8601
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
    readonly eventType = "WagerTransactionPendingReference";
    readonly version = 1;

    // Call after wager.markPendingReference(now). No balance moved, so there is no ledger entry to pass.
    static from(wager: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
        if (!wager.referenceExternalTransactionId || !wager.nextAttemptAt) {
            throw new Error('transaction is not waiting for a reference');   // caller bug
        }
        return new WagerTransactionPendingReference({
            ...ctx,
            aggregateId: wager.walletId,
            data: {
                walletId: wager.walletId,
                transactionId: wager.id,
                kind: wager.kind,
                referenceExternalTransactionId: wager.referenceExternalTransactionId,
                nextAttemptAt: wager.nextAttemptAt.toISOString(),
            },
        });
    }
}

import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";

function canonicalJson(value: unknown): string{
    //TODO
    return ''
}

interface PayloadFields {
    providerId: string,
    externalTransactionId: string,
    playerId: string,
    walletId: string,
    roundId: string,
    gameId: string,
    kind: WagerTransactionKind,
    money: Money,
    referenceExternalTransactionId?: string
}

function payloadHas(fields: PayloadFields): string{
    //TODO
    return ''
}

export {canonicalJson, payloadHas};
export type { PayloadFields };

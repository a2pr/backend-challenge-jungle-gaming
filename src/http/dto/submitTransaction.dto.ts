import {z} from "zod";
import {moneySchema} from "./money.dto.js";
import {WagerTransactionKind} from "../../wager/wagerTransactionKind.js";
import Money from "../../money/money.js";
import type {SubmitWagerCommand} from "../../wager/SubmitWagerTransaction.usecase.js";

const nonBlank = z.string().min(1);

export const submitTransactionSchema = z.object({
        providerId: nonBlank,
        externalTransactionId: nonBlank,
        playerId: z.uuid(),             // player_id is a uuid column: anything else would reach Postgres and come back as a 503
        walletId: z.uuid(),
        roundId: nonBlank,
        gameId: nonBlank,
        // every kind a provider may send; OPENING is internal (D4), so it is simply not in the list
        kind: z.enum([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
                WagerTransactionKind.Refund, WagerTransactionKind.Rollback]),
        money: moneySchema,
        referenceExternalTransactionId: nonBlank.optional(),
});
export type SubmitTransactionDto = z.infer<typeof submitTransactionSchema>;

export function toCommand(dto: SubmitTransactionDto, idempotencyKey: string): SubmitWagerCommand {
        return {...dto, idempotencyKey, money: Money.from(dto.money)};
}
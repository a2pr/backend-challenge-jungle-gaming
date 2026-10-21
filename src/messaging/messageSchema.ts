import {z} from "zod";
import {submitTransactionSchema, toCommand as dtoToCommand} from "../http/dto/submitTransaction.dto.js";
import type {SubmitWagerCommand} from "../wager/SubmitWagerTransaction.usecase.js";

// README §10. `data` is the HTTP body plus the idempotency key (HTTP carries it in a header); OPENING is excluded by the shared schema (D4).
export const wagerMessageSchema = z.object({
    messageId: z.string().min(1),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: submitTransactionSchema.extend({idempotencyKey: z.string().min(1)}),
});
export type WagerMessage = z.infer<typeof wagerMessageSchema>;

export const toCommand = (message: WagerMessage): SubmitWagerCommand =>
    dtoToCommand(message.data, message.data.idempotencyKey);

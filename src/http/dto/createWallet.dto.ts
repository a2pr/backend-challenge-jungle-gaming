import {z} from "zod";
import {moneySchema} from "./money.dto.js";

// CreateWalletCommand. A zero initialBalance is valid: no OPENING transaction is created.
export const createWalletSchema = z.object({playerId: z.uuid(), initialBalance: moneySchema})

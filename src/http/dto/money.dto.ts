import {z} from "zod";

// Scale 2 and at most 16 integer digits, so it always fits numeric(19,2) (max 9999999999999999.99).
// A leading "-" does not match, so negatives are rejected here; the "must be positive" rule is per kind (step 3).
export const moneySchema = z.object({
    amount: z.string().regex(/^\d{1,16}\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
})

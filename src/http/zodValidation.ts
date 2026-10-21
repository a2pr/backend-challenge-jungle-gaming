import type {z} from "zod";
import {BadRequestError} from "./errors.js";

// Parses at the HTTP boundary; the zod issues travel in `details` so the client sees which field failed.
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
    const result = schema.safeParse(input);
    if (!result.success) throw new BadRequestError('Invalid request', result.error.issues);
    return result.data;
}

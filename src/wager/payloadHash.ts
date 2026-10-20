import {WagerTransactionKind} from "./wagerTransactionKind.js";
import Money from "../money/money.js";
import {createHash} from 'node:crypto';

function canonicalJson(value: unknown): string {
    const canonicalized = canonicalizeValue(value);
    return JSON.stringify(canonicalized);
}

function canonicalizeValue(value: unknown): unknown {
    // 1. Invoke toJSON() if it exists (e.g., Money objects, Dates, etc.)
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        if (typeof (value as any).toJSON === 'function') {
            value = (value as any).toJSON();
        }
    }

    // 2. Handle undefined
    if (value === undefined) {
        return undefined;
    }

    // 3. Handle Primitives and null
    if (value === null || typeof value !== 'object') {
        return value;
    }

    // 4. Handle Arrays (preserve order, but canonicalize children)
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) {
            const canonicalItem = canonicalizeValue(item);
            // Standard JSON spec converts undefined elements in arrays to null
            result.push(canonicalItem === undefined ? null : canonicalItem);
        }
        return result;
    }

    // 5. Handle Objects (sort keys ascending at every depth)
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();

    for (const key of keys) {
        const propValue = (value as Record<string, unknown>)[key];
        const canonicalProp = canonicalizeValue(propValue);

        // Drop properties whose value is undefined
        if (canonicalProp !== undefined) {
            sortedObj[key] = canonicalProp;
        }
    }

    return sortedObj;
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

function payloadHash(fields: PayloadFields): string {
    const restrictedPayload = {
        providerId: fields.providerId,
        externalTransactionId: fields.externalTransactionId,
        playerId: fields.playerId,
        walletId: fields.walletId,
        roundId: fields.roundId,
        gameId: fields.gameId,
        kind: fields.kind,
        money: fields.money,
        referenceExternalTransactionId: fields.referenceExternalTransactionId,
    };

    const jsonText = canonicalJson(restrictedPayload);

    // Generate and return the SHA-256 hash digest in hex format
    return createHash('sha256').update(jsonText).digest('hex');
}

export {canonicalJson, payloadHash};
export type {PayloadFields};

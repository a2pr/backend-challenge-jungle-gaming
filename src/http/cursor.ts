import {BadRequestError} from "./errors.js";

// Opaque to clients: base64url of {"seq": n}. The ledger cursor is the monotonic `seq`, never an offset, so a page
// does not repeat or skip rows when entries arrive between two requests.
export function encodeCursor(seq: number): string {
    return Buffer.from(JSON.stringify({seq})).toString('base64url');
}

export function decodeCursor(cursor: string): number {
    try {
        const {seq} = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (Number.isSafeInteger(seq) && seq >= 0) return seq;
    } catch {
        // fall through: not base64url, not JSON
    }
    throw new BadRequestError('Invalid cursor');
}

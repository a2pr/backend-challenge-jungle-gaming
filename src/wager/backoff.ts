export function backoffMs(attempts: number, baseMs: number, capMs: number): number {
    if (attempts < 0) {
        throw Error('attempts should be non negative values')
    }

    if (!Number.isInteger(attempts) || !Number.isInteger(baseMs) || !Number.isInteger(capMs)) {
        throw Error('method only accepts integers')
    }

    return Math.min(baseMs * 2 ** attempts, capMs)
}
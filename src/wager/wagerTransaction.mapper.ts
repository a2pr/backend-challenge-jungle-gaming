import WagerTransaction from "./wagerTransaction.js";
import {WagerTransactionRow} from "./wagerTransaction.schema.js";
import Money from "../money/money.js";

export function toDomain(row: WagerTransactionRow): WagerTransaction {
    return WagerTransaction.rehydrate({
        id: row.id,
        providerId: row.providerId,
        externalTransactionId: row.externalTransactionId,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        walletId: row.walletId,
        playerId: row.playerId,
        roundId: row.roundId,
        gameId: row.gameId,
        kind: row.kind,
        money: Money.from({amount: row.amount, currency: row.currency}),
        referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
        createdAt: row.createdAt,
        status: row.status,
        referenceTransactionId: row.referenceTransactionId ?? undefined,
        failureCode: row.failureCode ?? undefined,
        processedAt: row.processedAt ?? undefined,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt ?? undefined,
    })
}

// extras.balanceAfter is not domain state; omit it and the column keeps its current value.
// Optionals map to null (never undefined) so the row always states every nullable column explicitly.
export function toRow(wagerTransaction: WagerTransaction, extras: { balanceAfter?: string } = {}): WagerTransactionRow {
    const row = Object.assign(new WagerTransactionRow(), {
        id: wagerTransaction.id,
        providerId: wagerTransaction.providerId,
        externalTransactionId: wagerTransaction.externalTransactionId,
        idempotencyKey: wagerTransaction.idempotencyKey,
        payloadHash: wagerTransaction.payloadHash,
        walletId: wagerTransaction.walletId,
        playerId: wagerTransaction.playerId,
        roundId: wagerTransaction.roundId,
        gameId: wagerTransaction.gameId,
        kind: wagerTransaction.kind,
        amount: wagerTransaction.money.toString(),
        currency: wagerTransaction.money.currency,
        referenceExternalTransactionId: wagerTransaction.referenceExternalTransactionId ?? null,
        createdAt: wagerTransaction.createdAt,
        status: wagerTransaction.status,
        referenceTransactionId: wagerTransaction.referenceTransactionId ?? null,
        failureCode: wagerTransaction.failureCode ?? null,
        processedAt: wagerTransaction.processedAt ?? null,
        attempts: wagerTransaction.attempts,
        nextAttemptAt: wagerTransaction.nextAttemptAt ?? null,
    })
    if (extras.balanceAfter !== undefined) row.balanceAfter = extras.balanceAfter
    return row
}

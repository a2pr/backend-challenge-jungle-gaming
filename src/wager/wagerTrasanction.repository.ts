import {EntityManager} from "@mikro-orm/core";
import WagerTransaction from "./wagerTransaction.js";
import {WagerTransactionRow} from "./wagerTransaction.schema.js";
import {toDomain, toRow} from "./wagerTransaction.mapper.js";
import {WagerTransactionKind} from "./wagerTransactionKind.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";

// balanceAfter is not domain state, so replays read it from here.
export type StoredWager = { transaction: WagerTransaction; balanceAfter: string | null };

export class WagerTransactionRepository {
    async findByIdempotencyKey(em: EntityManager, providerId: string, key: string): Promise<StoredWager | null> {
        const row = await em.findOne(WagerTransactionRow, {providerId, idempotencyKey: key});
        return row ? {transaction: toDomain(row), balanceAfter: row.balanceAfter} : null;
    }

    // Also the reference lookup: callers pass referenceExternalTransactionId as externalId.
    async findByExternalId(em: EntityManager, providerId: string, externalId: string): Promise<StoredWager | null> {
        const row = await em.findOne(WagerTransactionRow, {providerId, externalTransactionId: externalId});
        return row ? {transaction: toDomain(row), balanceAfter: row.balanceAfter} : null;
    }

    async findProcessedById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
        const row = await em.findOne(WagerTransactionRow, {id, status: WagerTransactionStatus.Processed});
        return row ? toDomain(row) : null;
    }

    // Same predicate as the partial unique index wager_one_reversal.
    async findReversalOf(em: EntityManager, referenceTransactionId: string): Promise<WagerTransaction | null> {
        const row = await em.findOne(WagerTransactionRow, {
            referenceTransactionId,
            status: WagerTransactionStatus.Processed,
            kind: {$in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]},
        });
        return row ? toDomain(row) : null;
    }

    async insert(em: EntityManager, tx: WagerTransaction, extras: { balanceAfter: string }): Promise<void> {
        await em.insert(WagerTransactionRow, toRow(tx, extras));
    }
}

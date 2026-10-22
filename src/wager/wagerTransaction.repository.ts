import {Injectable} from "@nestjs/common";
import {EntityManager} from "@mikro-orm/core";
import WagerTransaction from "./wagerTransaction.js";
import {WagerTransactionRow} from "./wagerTransaction.schema.js";
import {toDomain, toRow} from "./wagerTransaction.mapper.js";
import {WagerTransactionKind} from "./wagerTransactionKind.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";

// balanceAfter is not domain state, so replays read it from here.
export type StoredWager = { transaction: WagerTransaction; balanceAfter: string | null };

@Injectable()
export class WagerTransactionRepository {
    async findByIdempotencyKey(em: EntityManager, providerId: string, key: string): Promise<StoredWager | null> {
        const row = await em.findOne(WagerTransactionRow, {providerId, idempotencyKey: key});
        return row ? {transaction: toDomain(row), balanceAfter: row.balanceAfter} : null;
    }

    async findById(em: EntityManager, id: string): Promise<StoredWager | null> {
        const row = await em.findOne(WagerTransactionRow, {id});
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

    // The pending row after a retry: only the columns a transition can change.
    async update(em: EntityManager, tx: WagerTransaction, extras: { balanceAfter: string }): Promise<void> {
        const row = toRow(tx, extras);
        const updated = await em.nativeUpdate(WagerTransactionRow, {id: row.id}, {
            status: row.status, failureCode: row.failureCode, referenceTransactionId: row.referenceTransactionId,
            processedAt: row.processedAt, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, balanceAfter: row.balanceAfter,
        });
        if (updated !== 1) throw new Error(`Wager transaction ${row.id} not found`);
    }

    // Ids only: reprocess takes the wallet lock itself, so no row lock is held here across wallets (lock order).
    // Must run inside em.transactional; the locks end with that transaction.
    async findDuePendingReference(em: EntityManager, now: Date, limit: number): Promise<string[]> {
        const rows: { id: string }[] = await em.getConnection().execute(
            `SELECT id FROM wager_transactions
             WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
             ORDER BY next_attempt_at LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [now, limit],
            'all',
            em.getTransactionContext(), // join the caller's transaction, or the lock is released at once
        );
        return rows.map((r) => r.id);
    }
}

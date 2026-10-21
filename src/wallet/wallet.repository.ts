import Wallet from "./wallet.js";
import {EntityManager, LockMode} from "@mikro-orm/core";
import {toDomain, toRow} from "./wallet.mapper.js";
import {WalletRow} from "./wallet.schema.js";

export class WalletRepository {
    async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
        const results = await em.findOne(WalletRow, id, {
            lockMode: LockMode.PESSIMISTIC_WRITE
        })

        if (results == null) return null;
        return toDomain(results)
    }

    // em is the transactional fork handed in by the use case, so this INSERT joins its transaction.
    // em.insert runs the statement now (no persist/flush, no identity map); toRow gives the mapped row.
    async insert(em: EntityManager, wallet: Wallet): Promise<void> {
        await em.insert(WalletRow, toRow(wallet));
    }

    async save(em: EntityManager, wallet: Wallet): Promise<void> {
        const row = toRow(wallet)
        const updated = await em.nativeUpdate(
            WalletRow,
            {id: row.id, version: row.version - 1},
            {balance: row.balance, version: row.version, updatedAt: row.updatedAt}
        )
        if(updated !==1) throw new Error('Wallet version conflict')
    }
}
import Money from '../money/money.js';
import Wallet from './wallet.js';
import {WalletRow} from './wallet.schema.js';

export function toDomain(row: WalletRow): Wallet {
    return Wallet.rehydrate({
        id: row.id,
        playerId: row.playerId,
        currency: row.currency,
        balance: Money.from({amount: row.balance, currency: row.currency}),
        version: row.version,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    });
}

export function toRow(wallet: Wallet): WalletRow {
    return Object.assign(new WalletRow(), {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
    });
}

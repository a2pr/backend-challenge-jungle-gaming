import {EntitySchema} from '@mikro-orm/core';

// Plain row class: mirrors the table, no behaviour. The domain Wallet never imports the ORM;
// wallet.mapper.ts converts between the two.
export class WalletRow {
    id!: string;
    playerId!: string;
    currency!: string;
    balance!: string;   // numeric(19,2) as string, never a JS number (D10)
    version!: number;   // business version managed by the domain, not MikroORM's optimistic lock
    createdAt!: Date;
    updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
    class: WalletRow,
    tableName: 'wallets',
    properties: {
        id: {type: 'uuid', primary: true},
        playerId: {type: 'uuid', fieldName: 'player_id'},
        currency: {type: 'string', columnType: 'char(3)'},
        balance: {type: 'string', columnType: 'numeric(19,2)'},
        version: {type: 'integer', default: 1},
        createdAt: {type: 'Date', columnType: 'timestamptz', fieldName: 'created_at'},
        updatedAt: {type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at'},
    },
});

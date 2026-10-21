import {EntitySchema} from "@mikro-orm/core";
import {WagerTransactionKind} from "./wagerTransactionKind.js";
import {WagerTransactionStatus} from "./wagerTransactionStatus.js";
import {FailureCode} from "./failureCode.js";

// Plain row class mirroring wager_transactions. Nullable columns are `| null`: that is what Postgres returns.
export class WagerTransactionRow {
    id!: string;
    providerId!: string;
    externalTransactionId!: string;
    idempotencyKey!: string;
    payloadHash!: string;
    walletId!: string;
    playerId!: string;
    roundId!: string;
    gameId!: string;
    kind!: WagerTransactionKind;
    amount!: string;    // numeric(19,2) as string (D10)
    currency!: string;
    referenceExternalTransactionId!: string | null;
    referenceTransactionId!: string | null;
    status!: WagerTransactionStatus;
    failureCode!: FailureCode | null;
    balanceAfter!: string | null;   // not domain state: balance observed at the end of processing, for replays
    attempts!: number;
    nextAttemptAt!: Date | null;
    createdAt!: Date;
    processedAt!: Date | null;
}

// Column names come from the default naming strategy (camelCase -> snake_case).
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
    class: WagerTransactionRow,
    tableName: 'wager_transactions',
    properties: {
        id: {type: 'uuid', primary: true},
        providerId: {type: 'string'},
        externalTransactionId: {type: 'string'},
        idempotencyKey: {type: 'string'},
        payloadHash: {type: 'string', columnType: 'char(64)'},
        walletId: {type: 'uuid'},
        playerId: {type: 'uuid'},
        roundId: {type: 'string'},
        gameId: {type: 'string'},
        kind: {type: 'string'},
        amount: {type: 'string', columnType: 'numeric(19,2)'},
        currency: {type: 'string', columnType: 'char(3)'},
        referenceExternalTransactionId: {type: 'string', nullable: true},
        referenceTransactionId: {type: 'uuid', nullable: true},
        status: {type: 'string'},
        failureCode: {type: 'string', nullable: true},
        balanceAfter: {type: 'string', columnType: 'numeric(19,2)', nullable: true},
        attempts: {type: 'integer', default: 0},
        nextAttemptAt: {type: 'Date', columnType: 'timestamptz', nullable: true},
        createdAt: {type: 'Date', columnType: 'timestamptz'},
        processedAt: {type: 'Date', columnType: 'timestamptz', nullable: true},
    }
});

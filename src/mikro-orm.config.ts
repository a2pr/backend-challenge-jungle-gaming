import {defineConfig} from '@mikro-orm/postgresql';
import {Migrator} from "@mikro-orm/migrations";
import {WalletSchema} from './wallet/wallet.schema.js';
import {WagerTransactionSchema} from './wager/wagerTransaction.schema.js';
import {WalletLedgerEntrySchema} from './wallet/walletLedgerEntry.schema.js';
import {InboxMessageSchema} from './messaging/inboxMessage.schema.js';
import {OutboxMessageSchema} from './messaging/outboxMessage.schema.js';

export default defineConfig({
    clientUrl: process.env.DATABASE_URL,
    // Explicit list, not a *.schema.ts glob: the glob is imported natively by Node, which cannot resolve
    // the `.js` specifiers of .ts sources (breaks under vitest/ts). New schema = add it here.
    entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema],
    extensions: [Migrator],
    migrations: {path: './dist/migrations', pathTs: './src/migrations', transactional: true, snapshot: false},
    pool: {min: 2, max: Number(process.env.DATABASE_POOL_MAX ?? 20)}

});

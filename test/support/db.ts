import {MikroORM} from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config.js';

export const createOrm = () => MikroORM.init(config);

// Wipes everything, including the migrations table, so a spec starts from nothing.
export async function resetSchema(orm: MikroORM) {
    await orm.em.getConnection().execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

// RESTART IDENTITY resets ledger seq; row-level triggers do not fire on TRUNCATE.
export const truncateAll = (orm: MikroORM) =>
    orm.em.getConnection().execute(
        'TRUNCATE wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages RESTART IDENTITY CASCADE',
    );

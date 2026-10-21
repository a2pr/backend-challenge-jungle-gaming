import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';

let orm: MikroORM;
const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);

// UUIDs are fixed so inserts stay readable
const W1 = '00000000-0000-0000-0000-000000000001';
const W2 = '00000000-0000-0000-0000-000000000002';
const P1 = '10000000-0000-0000-0000-000000000001';
const T1 = '20000000-0000-0000-0000-000000000001';
const T2 = '20000000-0000-0000-0000-000000000002';
const T3 = '20000000-0000-0000-0000-000000000003';

type Row = Record<string, unknown>;
const insert = (table: string, row: Row) => {
    const cols = Object.keys(row);
    return sql(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(row));
};

const wallet = (o: Row = {}) =>
    insert('wallets', {id: W1, player_id: P1, currency: 'BRL', balance: '10.00', version: 1, created_at: new Date(), updated_at: new Date(), ...o});

const tx = (o: Row = {}) =>
    insert('wager_transactions', {
        id: T1, provider_id: 'prov', external_transaction_id: 'ext-1', idempotency_key: 'key-1', payload_hash: 'a'.repeat(64),
        wallet_id: W1, player_id: P1, round_id: 'r1', game_id: 'g1', kind: 'BET', amount: '5.00', currency: 'BRL',
        status: 'PENDING', created_at: new Date(), ...o,
    });

const ledger = (o: Row = {}) =>
    insert('wallet_ledger_entries', {
        id: '30000000-0000-0000-0000-000000000001', wallet_id: W1, transaction_id: T1, direction: 'DEBIT', amount: '5.00',
        currency: 'BRL', balance_before: '10.00', balance_after: '5.00', created_at: new Date(), ...o,
    });

// Postgres error codes: 23505 unique, 23514 check, P0001 raised by the trigger
const rejects = (p: Promise<unknown>, code: string) =>
    expect(p).rejects.toSatisfy((e: any) => e.code === code || e.cause?.code === code);

const tableExists = async (name: string) =>
    (await sql('SELECT to_regclass(?) AS t', [`public.${name}`]))[0].t !== null;

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
});
afterAll(() => orm.close());

describe('migration', () => {
    it('up, down, up again; down removes the tables', async () => {
        const migrator = orm.migrator;
        await migrator.up();
        expect(await tableExists('wallets')).toBe(true);
        await migrator.down({to: 0});
        for (const t of ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']) {
            expect(await tableExists(t)).toBe(false);
        }
        await migrator.up();
        expect(await tableExists('wallet_ledger_entries')).toBe(true);
    });
});

describe('constraints', () => {
    beforeEach(() => truncateAll(orm));

    describe('wallets', () => {
        it('rejects a negative balance', () => rejects(wallet({balance: '-0.01'}), '23514'));
        it('rejects a second wallet for the same (player, currency)', async () => {
            await wallet();
            await rejects(wallet({id: W2}), '23505');
        });
        it('allows the same player in another currency', async () => {
            await wallet();
            await wallet({id: W2, currency: 'USD'});
        });
    });

    describe('wager_transactions', () => {
        beforeEach(() => wallet());

        it('rejects a duplicate (provider, external id)', async () => {
            await tx();
            await rejects(tx({id: T2, idempotency_key: 'key-2'}), '23505');
        });
        it('rejects a duplicate (provider, idempotency key)', async () => {
            await tx();
            await rejects(tx({id: T2, external_transaction_id: 'ext-2'}), '23505');
        });
        it('allows the same external id from another provider', async () => {
            await tx();
            await tx({id: T2, provider_id: 'other', idempotency_key: 'key-2'});
        });
        it('rejects a REFUND without a reference', () => rejects(tx({kind: 'REFUND'}), '23514'));
        it('rejects a BET with a reference', () => rejects(tx({reference_external_transaction_id: 'x'}), '23514'));
        it('rejects a REJECTED without a failure code', () => rejects(tx({status: 'REJECTED'}), '23514'));
        it('rejects a PROCESSED without processed_at', () => rejects(tx({status: 'PROCESSED'}), '23514'));
        it('rejects a non-positive amount unless LOSS', async () => {
            await rejects(tx({amount: '0.00'}), '23514');
            await tx({id: T2, kind: 'LOSS', amount: '0.00', external_transaction_id: 'e2', idempotency_key: 'k2'});
        });

        describe('one PROCESSED reversal per referenced transaction', () => {
            const reversal = (id: string, n: string, o: Row = {}) =>
                tx({
                    id, kind: 'REFUND', reference_external_transaction_id: 'ext-1', reference_transaction_id: T1,
                    external_transaction_id: `ext-${n}`, idempotency_key: `key-${n}`,
                    status: 'PROCESSED', processed_at: new Date(), ...o,
                });
            beforeEach(() => tx({status: 'PROCESSED', processed_at: new Date()}));

            it('rejects a second PROCESSED reversal', async () => {
                await reversal(T2, '2');
                await rejects(reversal(T3, '3', {kind: 'ROLLBACK'}), '23505');
            });
            it('allows a REJECTED second one', async () => {
                await reversal(T2, '2');
                await reversal(T3, '3', {status: 'REJECTED', processed_at: null, failure_code: 'ALREADY_REVERSED'});
            });
        });
    });

    describe('wallet_ledger_entries', () => {
        beforeEach(async () => {
            await wallet();
            await tx();
        });

        it('accepts a consistent debit and credit', async () => {
            await ledger();
            await tx({id: T2, external_transaction_id: 'e2', idempotency_key: 'k2', kind: 'WIN'});
            await ledger({id: '30000000-0000-0000-0000-000000000002', transaction_id: T2, direction: 'CREDIT', balance_before: '5.00', balance_after: '10.00'});
        });
        it('rejects balance_after that does not follow the direction', () =>
            rejects(ledger({balance_after: '15.00'}), '23514'));
        it('rejects amount 0', () => rejects(ledger({amount: '0.00', balance_after: '10.00'}), '23514'));
        it('rejects a second entry for the same transaction', async () => {
            await ledger();
            await rejects(ledger({id: '30000000-0000-0000-0000-000000000002'}), '23505');
        });
        it('is append-only: UPDATE fails', async () => {
            await ledger();
            await rejects(sql(`UPDATE wallet_ledger_entries SET amount = '1.00'`), 'P0001');
        });
        it('is append-only: DELETE fails', async () => {
            await ledger();
            await rejects(sql('DELETE FROM wallet_ledger_entries'), 'P0001');
        });
        it('still allows TRUNCATE (test cleanup)', async () => {
            await ledger();
            await truncateAll(orm);
            expect(await sql('SELECT 1 FROM wallet_ledger_entries')).toHaveLength(0);
        });
    });
});

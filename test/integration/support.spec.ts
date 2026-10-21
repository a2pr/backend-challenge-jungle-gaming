import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, openWallet, runInParallel, uniqueExternalId} from '../support/fixtures.js';

let orm: MikroORM;
const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('assertLedgerMatchesBalance', () => {
    it('passes for a funded wallet (opening entry) and for an empty one (no entries)', async () => {
        const funded = await openWallet(orm, '100.00');
        const empty = await openWallet(orm, '0.00');
        await assertLedgerMatchesBalance(orm, funded.walletId);
        await assertLedgerMatchesBalance(orm, empty.walletId);
        expect(await sql('SELECT 1 FROM wallet_ledger_entries')).toHaveLength(1);
    });

    it('fails when the balance is edited by hand', async () => {
        const {walletId} = await openWallet(orm, '100.00');
        await sql(`UPDATE wallets SET balance = balance + 1 WHERE id = ?`, [walletId]);
        await expect(assertLedgerMatchesBalance(orm, walletId)).rejects.toThrow();
    });

    it('fails for an unknown wallet', async () => {
        await expect(assertLedgerMatchesBalance(orm, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    });
});

describe('fixtures', () => {
    it('openWallet stores the balance as an exact string with an OPENING transaction', async () => {
        const {walletId} = await openWallet(orm, '0.10');
        const [row] = await sql(`SELECT w.balance::text AS balance, t.kind, t.status, t.balance_after::text AS after
                                  FROM wallets w JOIN wager_transactions t ON t.wallet_id = w.id WHERE w.id = ?`, [walletId]);
        expect(row).toMatchObject({balance: '0.10', kind: 'OPENING', status: 'PROCESSED', after: '0.10'});
    });

    it('betCommand is unique per call and accepts overrides', () => {
        const a = betCommand({walletId: 'w', playerId: 'p'});
        const b = betCommand({walletId: 'w', playerId: 'p', roundId: 'r9'});
        expect(a.externalTransactionId).not.toBe(b.externalTransactionId);
        expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
        expect(b.roundId).toBe('r9');
        expect(uniqueExternalId()).not.toBe(uniqueExternalId());
    });

    it('runInParallel runs n calls at once and keeps their order', async () => {
        const started: number[] = [];
        const out = await runInParallel(5, async (i) => {
            started.push(i);
            await new Promise((r) => setTimeout(r, 10));
            return i * 2;
        });
        expect(out).toEqual([0, 2, 4, 6, 8]);
        expect(started).toEqual([0, 1, 2, 3, 4]);
    });
});

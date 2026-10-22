import {randomUUID} from 'node:crypto';
import {INestApplication, Logger} from '@nestjs/common';
import {MikroORM} from '@mikro-orm/postgresql';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createTestApp} from '../support/app.js';
import {resetSchema, truncateAll} from '../support/db.js';
import {openWallet} from '../support/fixtures.js';
import {INSTANCE_ID} from '../../src/observability/instance.js';

let app: INestApplication;
let http: Awaited<ReturnType<typeof createTestApp>>['http'];
let orm: MikroORM;

beforeAll(async () => {
    ({app, http} = await createTestApp());
    orm = app.get(MikroORM);
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => app.close());
beforeEach(() => truncateAll(orm));
afterEach(() => vi.restoreAllMocks());

const money = (amount: string) => ({amount, currency: 'BRL'});
const reconcile = (walletId: string) => http.post(`/wallets/${walletId}/reconciliation`);
const bet = (wallet: {walletId: string; playerId: string}, amount: string) =>
    http.post('/wagering/transactions').set('Idempotency-Key', `key-${randomUUID()}`).send({
        providerId: 'prov-1', externalTransactionId: `ext-${randomUUID()}`, playerId: wallet.playerId, walletId: wallet.walletId,
        roundId: 'r', gameId: 'g', kind: 'BET', money: money(amount),
    }).expect(200);
const storedBalance = async (walletId: string) =>
    (await orm.em.getConnection().execute('SELECT balance::text AS balance, version FROM wallets WHERE id = ?', [walletId]))[0];

describe('POST /wallets/:id/reconciliation', () => {
    it('a consistent wallet: consistent true, zero difference, the number of entries checked', async () => {
        const wallet = await openWallet(orm, '100.00');
        await bet(wallet, '30.00');

        const res = await reconcile(wallet.walletId).expect(200);

        expect(res.body).toEqual({
            walletId: wallet.walletId, storedBalance: money('70.00'), calculatedBalance: money('70.00'),
            difference: money('0.00'), consistent: true, checkedEntries: 2,
        });
    });

    it('a wallet with no entries is consistent at zero', async () => {
        const wallet = await openWallet(orm, '0.00');
        const res = await reconcile(wallet.walletId).expect(200);

        expect(res.body).toMatchObject({consistent: true, checkedEntries: 0, storedBalance: money('0.00'), calculatedBalance: money('0.00')});
    });

    it('a corrupted balance: consistent false, the signed difference, an error log, and nothing is repaired', async () => {
        const wallet = await openWallet(orm, '100.00');
        await bet(wallet, '30.00');
        const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        await orm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['75.50', wallet.walletId]);
        const before = await storedBalance(wallet.walletId);

        const res = await reconcile(wallet.walletId).expect(200);

        expect(res.body).toEqual({
            walletId: wallet.walletId, storedBalance: money('75.50'), calculatedBalance: money('70.00'),
            difference: money('5.50'), consistent: false, checkedEntries: 2,
        });
        // ids only: README §12 keeps amounts out of the logs (they are in the response body)
        expect(errorLog).toHaveBeenCalledWith({event: 'reconciliation.mismatch', instanceId: INSTANCE_ID, walletId: wallet.walletId});
        expect(await storedBalance(wallet.walletId)).toEqual(before);                        // never repaired
        expect((await reconcile(wallet.walletId).expect(200)).body.consistent).toBe(false);  // and still reported next time
        const [{n}] = await orm.em.getConnection().execute('SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [wallet.walletId]);
        expect(n).toBe(2);                                                                   // no compensating entry
    });

    it('a stored balance below the ledger gives a negative difference', async () => {
        const wallet = await openWallet(orm, '100.00');
        await orm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['40.00', wallet.walletId]);

        const res = await reconcile(wallet.walletId).expect(200);

        expect(res.body).toMatchObject({consistent: false, difference: money('-60.00')});
    });

    it('a consistent wallet writes no error log', async () => {
        const wallet = await openWallet(orm, '100.00');
        const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        await reconcile(wallet.walletId).expect(200);

        expect(errorLog).not.toHaveBeenCalled();
    });

    it('an unknown wallet is 404 and a bad id is 400', async () => {
        const unknown = await reconcile(randomUUID()).expect(404);
        expect(unknown.body).toMatchObject({code: 'WALLET_NOT_FOUND'});
        await reconcile('not-a-uuid').expect(400);
    });
});

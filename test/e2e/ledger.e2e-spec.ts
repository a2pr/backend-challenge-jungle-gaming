import {randomUUID} from 'node:crypto';
import {INestApplication} from '@nestjs/common';
import {MikroORM} from '@mikro-orm/postgresql';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestApp} from '../support/app.js';
import {resetSchema, truncateAll} from '../support/db.js';
import {openWallet} from '../support/fixtures.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';

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

const bet = (wallet: {walletId: string; playerId: string}, amount = '1.00') =>
    http.post('/wagering/transactions').set('Idempotency-Key', `key-${randomUUID()}`).send({
        providerId: 'prov-1', externalTransactionId: `ext-${randomUUID()}`, playerId: wallet.playerId, walletId: wallet.walletId,
        roundId: 'r', gameId: 'g', kind: 'BET', money: {amount, currency: 'BRL'},
    }).expect(200);
const ledger = (walletId: string, query = '') => http.get(`/wallets/${walletId}/ledger${query}`);
// 1 OPENING credit of 1000.00, then `n` debits of 1.00: a wallet with n + 1 ledger entries, written in order.
async function walletWithEntries(total: number) {
    const wallet = await openWallet(orm, '1000.00');
    for (let i = 1; i < total; i++) await bet(wallet);
    return wallet;
}
type Item = {id: string; transactionId: string; direction: string; amount: string; currency: string; balanceBefore: string; balanceAfter: string; createdAt: string};
// Each entry starts from the balance the previous one ended on: proves order and that nothing is missing.
const expectChain = (items: Item[]) => items.forEach((item, i) => {
    if (i > 0) expect(item.balanceBefore, `entry ${i} continues entry ${i - 1}`).toBe(items[i - 1].balanceAfter);
});

describe('GET /wallets/:id/ledger', () => {
    it('returns the entries with the README §6.4 fields, as strings', async () => {
        const wallet = await walletWithEntries(2);
        const res = await ledger(wallet.walletId).expect(200);

        expect(res.body.nextCursor).toBeNull();
        expect(res.body.items).toEqual([
            {id: expect.any(String), transactionId: expect.any(String), direction: 'CREDIT', amount: '1000.00', currency: 'BRL',
                balanceBefore: '0.00', balanceAfter: '1000.00', createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/)},
            {id: expect.any(String), transactionId: expect.any(String), direction: 'DEBIT', amount: '1.00', currency: 'BRL',
                balanceBefore: '1000.00', balanceAfter: '999.00', createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/)},
        ]);
        expect(res.body.items[0]).not.toHaveProperty('seq');
    });

    it('a wallet with no entries has an empty page; an unknown wallet is 404; a bad id is 400', async () => {
        const empty = await openWallet(orm, '0.00');
        expect((await ledger(empty.walletId).expect(200)).body).toEqual({items: [], nextCursor: null});

        const unknown = await ledger(randomUUID()).expect(404);
        expect(unknown.body).toMatchObject({code: 'WALLET_NOT_FOUND'});
        await ledger('not-a-uuid').expect(400);
    });

    it('120 entries in pages of 50 give 50, 50, 20: no duplicates, no gaps, last cursor null', async () => {
        const wallet = await walletWithEntries(120);

        const sizes: number[] = [];
        const all: Item[] = [];
        let cursor: string | null = null;
        do {
            const res: {body: {items: Item[]; nextCursor: string | null}} =
                await ledger(wallet.walletId, `?limit=50${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
            sizes.push(res.body.items.length);
            all.push(...res.body.items);
            cursor = res.body.nextCursor;
        } while (cursor);

        expect(sizes).toEqual([50, 50, 20]);
        expect(new Set(all.map((i) => i.id)).size).toBe(120);
        expectChain(all);
        expect(all[0].balanceBefore).toBe('0.00');
        expect(all[119].balanceAfter).toBe('881.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a page that ends exactly at the last entry has a null cursor (no empty extra page)', async () => {
        const wallet = await walletWithEntries(4);
        const res = await ledger(wallet.walletId, '?limit=4').expect(200);

        expect(res.body.items).toHaveLength(4);
        expect(res.body.nextCursor).toBeNull();
    });

    it('an entry written between two page requests neither repeats nor skips a row', async () => {
        const wallet = await walletWithEntries(10);
        const first = await ledger(wallet.walletId, '?limit=6').expect(200);
        expect(first.body.nextCursor).not.toBeNull();

        await bet(wallet);   // the 11th entry arrives while the client is paging

        const second = await ledger(wallet.walletId, `?limit=6&cursor=${first.body.nextCursor}`).expect(200);
        const all = [...first.body.items, ...second.body.items];

        expect(second.body.items).toHaveLength(5);          // 4 left from before, plus the new one
        expect(new Set(all.map((i: Item) => i.id)).size).toBe(11);
        expectChain(all);
        expect(second.body.nextCursor).toBeNull();
    });

    it('the default limit is 50 and a limit above 200 is capped', async () => {
        const wallet = await walletWithEntries(205);

        const byDefault = await ledger(wallet.walletId).expect(200);
        const capped = await ledger(wallet.walletId, '?limit=1000').expect(200);

        expect(byDefault.body.items).toHaveLength(50);
        expect(capped.body.items).toHaveLength(200);
        expect(capped.body.nextCursor).not.toBeNull();
    });

    it('never shows another wallet\'s entries', async () => {
        const a = await walletWithEntries(3);
        const b = await walletWithEntries(5);

        expect((await ledger(a.walletId).expect(200)).body.items).toHaveLength(3);
        expect((await ledger(b.walletId).expect(200)).body.items).toHaveLength(5);
    });

    it.each([
        ['a garbage cursor', '?cursor=hello'],
        ['a cursor with a negative seq', `?cursor=${Buffer.from('{"seq":-1}').toString('base64url')}`],
        ['limit 0', '?limit=0'],
        ['a negative limit', '?limit=-5'],
        ['a fractional limit', '?limit=1.5'],
        ['a limit that is not a number', '?limit=abc'],
        ['an empty cursor', '?cursor='],
    ])('%s is 400 VALIDATION_ERROR', async (_name, query) => {
        const wallet = await openWallet(orm, '10.00');
        const res = await ledger(wallet.walletId, query).expect(400);
        expect(res.body).toMatchObject({status: 400, code: 'VALIDATION_ERROR', retryable: false});
    });
});

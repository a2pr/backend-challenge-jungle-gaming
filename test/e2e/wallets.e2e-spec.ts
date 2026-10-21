import {randomUUID} from 'node:crypto';
import {INestApplication} from '@nestjs/common';
import {MikroORM} from '@mikro-orm/postgresql';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestApp} from '../support/app.js';
import {resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';

let app: INestApplication;
let http: Awaited<ReturnType<typeof createTestApp>>['http'];
let orm: MikroORM;

const money = (amount: string, currency = 'BRL') => ({amount, currency});
const count = async (table: string, walletId: string) =>
    Number((await orm.em.getConnection().execute(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wallet_id = ?`, [walletId]))[0].n);

beforeAll(async () => {
    ({app, http} = await createTestApp());
    orm = app.get(MikroORM);
    await resetSchema(orm);
    await orm.migrator.up();
});
afterAll(() => app.close());
beforeEach(() => truncateAll(orm));

describe('POST /wallets', () => {
    it('creates a wallet and answers 201 with the README body', async () => {
        const playerId = randomUUID();
        const res = await http.post('/wallets').send({playerId, initialBalance: money('1000.00')}).expect(201);

        expect(res.body).toEqual({id: expect.any(String), playerId, balance: money('1000.00'), version: 1});
        await assertLedgerMatchesBalance(orm, res.body.id);
        expect(await count('wallet_ledger_entries', res.body.id)).toBe(1);   // the OPENING credit
    });

    it('a zero balance creates a wallet with no ledger row', async () => {
        const res = await http.post('/wallets').send({playerId: randomUUID(), initialBalance: money('0.00')}).expect(201);

        expect(res.body.balance).toEqual(money('0.00'));
        expect(await count('wallet_ledger_entries', res.body.id)).toBe(0);
        await assertLedgerMatchesBalance(orm, res.body.id);
    });

    it('the same player in the same currency is 409 DUPLICATE_WALLET; another currency is fine', async () => {
        const playerId = randomUUID();
        await http.post('/wallets').send({playerId, initialBalance: money('1.00')}).expect(201);

        const dup = await http.post('/wallets').send({playerId, initialBalance: money('5.00')}).expect(409);
        expect(dup.body).toMatchObject({status: 409, code: 'DUPLICATE_WALLET', retryable: false});

        await http.post('/wallets').send({playerId, initialBalance: money('5.00', 'USD')}).expect(201);
    });

    it.each([
        ['negative amount', {initialBalance: money('-1.00')}],
        ['one decimal', {initialBalance: money('1.5')}],
        ['exponent', {initialBalance: money('1e3')}],
        ['amount as a number', {initialBalance: {amount: 1, currency: 'BRL'}}],
        ['lowercase currency', {initialBalance: money('1.00', 'brl')}],
        ['too large for numeric(19,2)', {initialBalance: money('10000000000000000.00')}],
        ['missing initialBalance', {initialBalance: undefined}],
        ['playerId not a uuid', {playerId: 'player-1', initialBalance: money('1.00')}],
    ])('rejects %s with 400 and the zod issues', async (_name, patch) => {
        const body = Object.assign({playerId: randomUUID(), initialBalance: money('1.00')}, patch);
        const res = await http.post('/wallets').send(body).expect(400);

        expect(res.body).toMatchObject({status: 400, code: 'VALIDATION_ERROR', retryable: false});
        expect(res.body.details).toBeInstanceOf(Array);
    });

    it('a missing playerId is 400', async () => {
        await http.post('/wallets').send({initialBalance: money('1.00')}).expect(400);
    });

    it('creates nothing when the body is invalid', async () => {
        await http.post('/wallets').send({playerId: randomUUID(), initialBalance: money('-1.00')}).expect(400);
        const [{n}] = await orm.em.getConnection().execute('SELECT COUNT(*)::int AS n FROM wallets');
        expect(n).toBe(0);
    });
});

describe('GET /wallets/:id', () => {
    it('returns the created wallet', async () => {
        const playerId = randomUUID();
        const created = await http.post('/wallets').send({playerId, initialBalance: money('250.00')}).expect(201);

        const res = await http.get(`/wallets/${created.body.id}`).expect(200);

        expect(res.body).toEqual(created.body);
    });

    it('an unknown wallet is 404 WALLET_NOT_FOUND', async () => {
        const res = await http.get(`/wallets/${randomUUID()}`).expect(404);
        expect(res.body).toMatchObject({status: 404, code: 'WALLET_NOT_FOUND', retryable: false});
    });

    it('an id that is not a uuid is 400, not a database error', async () => {
        const res = await http.get('/wallets/not-a-uuid').expect(400);
        expect(res.body).toMatchObject({status: 400, code: 'VALIDATION_ERROR'});
    });
});

describe('auth', () => {
    it('the wallet routes work without any auth header (no-op guard) and health stays public', async () => {
        await http.get('/health/live').expect(200);
        await http.post('/wallets').send({playerId: randomUUID(), initialBalance: money('1.00')}).expect(201);
    });
});

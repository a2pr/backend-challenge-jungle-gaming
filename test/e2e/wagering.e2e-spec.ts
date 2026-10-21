import {randomUUID} from 'node:crypto';
import {INestApplication} from '@nestjs/common';
import {MikroORM} from '@mikro-orm/postgresql';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestApp} from '../support/app.js';
import {resetSchema, truncateAll} from '../support/db.js';
import {openWallet, runInParallel} from '../support/fixtures.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {submitTransactionSchema, toCommand} from '../../src/http/dto/submitTransaction.dto.js';
import WagerTransaction from '../../src/wager/wagerTransaction.js';
import * as txMapper from '../../src/wager/wagerTransaction.mapper.js';
import {FailureCode} from '../../src/wager/failureCode.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';

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

const money = (amount: string, currency = 'BRL') => ({amount, currency});
const key = () => `key-${randomUUID()}`;
const bodyFor = (wallet: {walletId: string; playerId: string}, o: Record<string, unknown> = {}) => ({
    providerId: 'prov-1', externalTransactionId: `ext-${randomUUID()}`, playerId: wallet.playerId, walletId: wallet.walletId,
    roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: money('10.00'), ...o,
});
const submit = (idempotencyKey: string | undefined, body: unknown, client = http) => {
    const req = client.post('/wagering/transactions');
    if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
};
const walletBalance = async (walletId: string) => (await http.get(`/wallets/${walletId}`).expect(200)).body.balance.amount;
const countRows = async (table: string, walletId: string) =>
    Number((await orm.em.getConnection().execute(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wallet_id = ?`, [walletId]))[0].n);

// A FAILED row is only written by the consumer (phase 7), so tests create it directly, with the hash the request produces.
async function insertFailed(body: Record<string, unknown>, idempotencyKey: string, balanceAfter = '100.00') {
    const failed = WagerTransaction.create({id: randomUUID(), ...toCommand(submitTransactionSchema.parse(body), idempotencyKey), now: new Date()});
    failed.fail(FailureCode.ProcessingError);
    const em = orm.em.fork();
    em.persist(txMapper.toRow(failed, {balanceAfter}));
    await em.flush();
    return failed;
}

describe('POST /wagering/transactions: outcomes', () => {
    it('processes a BET: 200, balance reduced, one ledger debit', async () => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet)).expect(200);

        expect(res.body).toEqual({transactionId: expect.any(String), status: 'PROCESSED', balance: money('90.00'), idempotentReplay: false});
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('credits a WIN', async () => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet, {kind: 'WIN', money: money('40.00')})).expect(200);

        expect(res.body.balance).toEqual(money('140.00'));
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a business refusal is 422 with the failureCode, balance untouched, and is stored', async () => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet, {money: money('500.00')})).expect(422);

        expect(res.body).toMatchObject({status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: money('100.00'), idempotentReplay: false});
        expect(await walletBalance(wallet.walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a reversal whose reference has not arrived is 202 PENDING_REFERENCE', async () => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet, {kind: 'REFUND', referenceExternalTransactionId: 'bet-not-seen-yet'})).expect(202);

        expect(res.body).toMatchObject({status: 'PENDING_REFERENCE', balance: money('100.00')});
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a REFUND of a processed BET gives the stake back', async () => {
        const wallet = await openWallet(orm, '100.00');
        const bet = bodyFor(wallet);
        await submit(key(), bet).expect(200);
        const res = await submit(key(), bodyFor(wallet, {kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId})).expect(200);

        expect(res.body.balance).toEqual(money('100.00'));
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });
});

describe('POST /wagering/transactions: idempotency', () => {
    it('the same request twice is a replay: same transaction, one debit', async () => {
        const wallet = await openWallet(orm, '100.00');
        const k = key();
        const body = bodyFor(wallet);

        const first = await submit(k, body).expect(200);
        const second = await submit(k, body).expect(200);

        expect(second.body).toEqual({...first.body, idempotentReplay: true});
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
        expect(await countRows('wallet_ledger_entries', wallet.walletId)).toBe(2);   // OPENING + one BET
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a replayed rejection is still 422', async () => {
        const wallet = await openWallet(orm, '100.00');
        const k = key();
        const body = bodyFor(wallet, {money: money('500.00')});

        await submit(k, body).expect(422);
        const replay = await submit(k, body).expect(422);

        expect(replay.body).toMatchObject({failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true});
    });

    it('the same key with a different payload is 409 IDEMPOTENCY_CONFLICT and changes nothing', async () => {
        const wallet = await openWallet(orm, '100.00');
        const k = key();
        const body = bodyFor(wallet);
        await submit(k, body).expect(200);

        const res = await submit(k, {...body, money: money('20.00')}).expect(409);

        expect(res.body).toMatchObject({status: 409, code: 'IDEMPOTENCY_CONFLICT', retryable: false});
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('a new key for a known external id is 409 DUPLICATE_EXTERNAL_TRANSACTION', async () => {
        const wallet = await openWallet(orm, '100.00');
        const body = bodyFor(wallet);
        await submit(key(), body).expect(200);

        const res = await submit(key(), body).expect(409);

        expect(res.body).toMatchObject({code: 'DUPLICATE_EXTERNAL_TRANSACTION', retryable: false});
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
    });

    it('a replay of a FAILED transaction is 409 with status FAILED', async () => {
        const wallet = await openWallet(orm, '100.00');
        const k = key();
        const body = bodyFor(wallet);
        await insertFailed(body, k);

        const res = await submit(k, body).expect(409);

        expect(res.body).toMatchObject({status: 'FAILED', failureCode: 'PROCESSING_ERROR', idempotentReplay: true});
    });

    it('ten identical requests at once: one debit, one original, nine replays', async () => {
        const wallet = await openWallet(orm, '100.00');
        const k = key();
        const body = bodyFor(wallet);

        const responses = await runInParallel(10, () => submit(k, body));

        expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
        expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
        expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('the same key on two wallets at once: one wins, the other is a 409 conflict, never a 5xx', async () => {
        const a = await openWallet(orm, '100.00');
        const b = await openWallet(orm, '100.00');
        const k = key();

        const responses = await runInParallel(2, (i) => submit(k, bodyFor(i === 0 ? a : b, {externalTransactionId: 'same-ext'})));

        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe('IDEMPOTENCY_CONFLICT');
        await assertLedgerMatchesBalance(orm, a.walletId);
        await assertLedgerMatchesBalance(orm, b.walletId);
    });
});

describe('POST /wagering/transactions: bad requests', () => {
    it('a missing, empty or over-long Idempotency-Key is 400', async () => {
        const wallet = await openWallet(orm, '100.00');
        for (const k of [undefined, '', 'k'.repeat(256)]) {
            const res = await submit(k, bodyFor(wallet)).expect(400);
            expect(res.body).toMatchObject({code: 'VALIDATION_ERROR', retryable: false});
        }
        expect(await walletBalance(wallet.walletId)).toBe('100.00');
    });

    it('a key of exactly 255 characters is accepted', async () => {
        const wallet = await openWallet(orm, '100.00');
        await submit('k'.repeat(255), bodyFor(wallet)).expect(200);
    });

    it.each([
        ['OPENING is internal', {kind: 'OPENING'}],
        ['unknown kind', {kind: 'TIP'}],
        ['amount 1.5', {money: money('1.5')}],
        ['negative amount', {money: money('-1.00')}],
        ['exponent amount', {money: money('1e3')}],
        ['walletId not a uuid', {walletId: 'wallet-1'}],
        ['playerId not a uuid', {playerId: 'player-1'}],
        ['missing roundId', {roundId: undefined}],
    ])('rejects %s with 400 and the zod issues', async (_name, patch) => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet, patch)).expect(400);

        expect(res.body).toMatchObject({status: 400, code: 'VALIDATION_ERROR'});
        expect(res.body.details).toBeInstanceOf(Array);
        expect(await walletBalance(wallet.walletId)).toBe('100.00');
    });

    it.each([
        ['a BET of zero', {money: money('0.00')}],
        ['a REFUND without a reference', {kind: 'REFUND'}],
        ['a BET with a reference', {referenceExternalTransactionId: 'x'}],
    ])('the domain rejects %s with 400', async (_name, patch) => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor(wallet, patch)).expect(400);

        expect(res.body).toMatchObject({code: 'VALIDATION_ERROR', retryable: false});
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });

    it('an empty body is 400', async () => {
        await submit(key(), {}).expect(400);
    });

    it('an unknown wallet is 404 WALLET_NOT_FOUND', async () => {
        const res = await submit(key(), bodyFor({walletId: randomUUID(), playerId: randomUUID()})).expect(404);
        expect(res.body).toMatchObject({code: 'WALLET_NOT_FOUND', retryable: false});
    });

    it('a request for another player\'s wallet is a stored 422 PLAYER_MISMATCH', async () => {
        const wallet = await openWallet(orm, '100.00');
        const res = await submit(key(), bodyFor({walletId: wallet.walletId, playerId: randomUUID()})).expect(422);

        expect(res.body).toMatchObject({status: 'REJECTED', failureCode: 'PLAYER_MISMATCH'});
        expect(await walletBalance(wallet.walletId)).toBe('100.00');
    });
});

describe('POST /wagering/transactions: headers', () => {
    it('echoes x-correlation-id, or generates one', async () => {
        const wallet = await openWallet(orm, '100.00');

        const given = await submit(key(), bodyFor(wallet)).set('x-correlation-id', 'trace-abc').expect(200);
        expect(given.headers['x-correlation-id']).toBe('trace-abc');

        const generated = await submit(key(), bodyFor(wallet)).expect(200);
        expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('works without any auth header (no-op guard)', async () => {
        const wallet = await openWallet(orm, '100.00');
        await submit(key(), bodyFor(wallet)).expect(200);
    });
});

describe('POST /wagering/transactions: infrastructure failure', () => {
    it('a lost database connection is a retryable 503 with Retry-After', async () => {
        const broken = await createTestApp((b) => b.overrideProvider(WalletRepository).useValue({
            lockById: async () => { throw new Error('connection terminated unexpectedly'); },
        }));
        try {
            const wallet = await openWallet(orm, '100.00');
            const res = await submit(key(), bodyFor(wallet), broken.http).expect(503);

            expect(res.headers['retry-after']).toBe('1');
            expect(res.body).toMatchObject({status: 503, code: 'TEMPORARILY_UNAVAILABLE', retryable: true});
            expect(JSON.stringify(res.body)).not.toContain('connection terminated');   // the cause is logged, not sent
        } finally {
            await broken.app.close();
        }
    });
});

describe('GET transactions', () => {
    const byId = (id: string) => http.get(`/wagering/transactions/${id}`);
    const byExternal = (provider: string, externalId: string) =>
        http.get(`/providers/${encodeURIComponent(provider)}/wagering/transactions/${encodeURIComponent(externalId)}`);
    const countTransactions = async () =>
        Number((await orm.em.getConnection().execute('SELECT COUNT(*)::int AS n FROM wager_transactions'))[0].n);

    it('returns a PROCESSED transaction by id and by provider external id, the same body as the POST (without the replay flag)', async () => {
        const wallet = await openWallet(orm, '100.00');
        const body = bodyFor(wallet);
        const posted = await submit(key(), body).expect(200);

        const viaId = await byId(posted.body.transactionId).expect(200);
        const viaExternal = await byExternal('prov-1', body.externalTransactionId).expect(200);

        expect(viaId.body).toEqual(posted.body);
        expect(viaExternal.body).toEqual(posted.body);
    });

    it('a REJECTED transaction is 200 on a GET (422 only on the POST), with its failureCode', async () => {
        const wallet = await openWallet(orm, '100.00');
        const posted = await submit(key(), bodyFor(wallet, {money: money('500.00')})).expect(422);

        const res = await byId(posted.body.transactionId).expect(200);

        expect(res.body).toEqual({
            transactionId: posted.body.transactionId, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS',
            balance: money('100.00'), idempotentReplay: false,
        });
    });

    it('a PENDING_REFERENCE transaction is 200 with its status', async () => {
        const wallet = await openWallet(orm, '100.00');
        const posted = await submit(key(), bodyFor(wallet, {kind: 'REFUND', referenceExternalTransactionId: 'not-seen'})).expect(202);

        const res = await byId(posted.body.transactionId).expect(200);

        expect(res.body).toMatchObject({status: 'PENDING_REFERENCE', balance: money('100.00')});
        expect(res.body).not.toHaveProperty('failureCode');
    });

    it('a FAILED transaction is 200 with PROCESSING_ERROR', async () => {
        const wallet = await openWallet(orm, '100.00');
        const body = bodyFor(wallet);
        const failed = await insertFailed(body, key());

        const res = await byExternal('prov-1', body.externalTransactionId).expect(200);

        expect(res.body).toEqual({
            transactionId: failed.id, status: 'FAILED', failureCode: 'PROCESSING_ERROR', balance: money('100.00'), idempotentReplay: false,
        });
    });

    it('balance is the balance after that transaction, not the wallet\'s current balance', async () => {
        const wallet = await openWallet(orm, '100.00');
        const first = await submit(key(), bodyFor(wallet)).expect(200);
        await submit(key(), bodyFor(wallet)).expect(200);

        const res = await byId(first.body.transactionId).expect(200);

        expect(res.body.balance).toEqual(money('90.00'));
        expect(await walletBalance(wallet.walletId)).toBe('80.00');
    });

    it('an external id with characters that need URL encoding is found', async () => {
        const wallet = await openWallet(orm, '100.00');
        const externalTransactionId = 'provider-a:transaction 123/x';
        await submit(key(), bodyFor(wallet, {externalTransactionId})).expect(200);

        await byExternal('prov-1', externalTransactionId).expect(200);
    });

    it('an unknown id is 404 TRANSACTION_NOT_FOUND', async () => {
        const res = await byId(randomUUID()).expect(404);
        expect(res.body).toMatchObject({status: 404, code: 'TRANSACTION_NOT_FOUND', retryable: false});
    });

    it('an id that is not a uuid is 400, not a database error', async () => {
        const res = await byId('not-a-uuid').expect(400);
        expect(res.body).toMatchObject({status: 400, code: 'VALIDATION_ERROR'});
    });

    it('an unknown external id is 404, and so is a known one under another provider', async () => {
        const wallet = await openWallet(orm, '100.00');
        const body = bodyFor(wallet);
        await submit(key(), body).expect(200);

        await byExternal('prov-1', 'never-sent').expect(404);
        const otherProvider = await byExternal('prov-2', body.externalTransactionId).expect(404);
        expect(otherProvider.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('reads change nothing', async () => {
        const wallet = await openWallet(orm, '100.00');
        const body = bodyFor(wallet);
        const posted = await submit(key(), body).expect(200);
        const rows = await countTransactions();

        await byId(posted.body.transactionId).expect(200);
        await byExternal('prov-1', body.externalTransactionId).expect(200);

        expect(await countTransactions()).toBe(rows);
        expect(await walletBalance(wallet.walletId)).toBe('90.00');
        await assertLedgerMatchesBalance(orm, wallet.walletId);
    });
});

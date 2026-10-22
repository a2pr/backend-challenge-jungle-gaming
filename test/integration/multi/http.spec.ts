import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../../support/db.js';
import {assertLedgerMatchesBalance} from '../../support/ledger.js';
import {createTestQueues} from '../../support/sqs.js';
import {dumpOutput, startInstances, type Instances} from '../../support/instances.js';
import {count, newTx, post} from '../../support/multi.js';

let orm: MikroORM;
let instances: Instances;
let ports: number[];

const balanceOf = async (walletId: string) =>
    (await orm.em.getConnection().execute('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b as string;

// Opened through instance 0 and read through instance 1: they share state or this fails.
async function openWallet(amount = '100.00') {
    const playerId = crypto.randomUUID();
    const created = await fetch(`http://localhost:${ports[0]}/wallets`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({playerId, initialBalance: {amount, currency: 'BRL'}}),
    });
    expect(created.status).toBe(201);
    const {id: walletId} = await created.json() as { id: string };
    const read = await (await fetch(`http://localhost:${ports[1]}/wallets/${walletId}`)).json() as { balance: { amount: string } };
    expect(read.balance.amount).toBe(amount);
    return {walletId, playerId};
}

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    instances = await startInstances(3, {queues: await createTestQueues(), extraEnv: {OUTBOX_POLL_MS: '200'}});
    ports = instances.map((i) => i.port);
});
afterAll(async () => {
    await instances?.stop();
    await orm.close();
});
beforeEach(() => truncateAll(orm));
afterEach((ctx) => { if (ctx.task.result?.state === 'fail') dumpOutput(instances); });

describe('HTTP across 3 instances', () => {
    it('30 BETs of 10.00 on 100.00, round-robin over the ports at once: exactly 10 PROCESSED and 20 INSUFFICIENT_FUNDS', async () => {
        const w = await openWallet();
        const requests = Array.from({length: 30}, (_, i) => ({port: ports[i % ports.length], tx: newTx(w)}));

        const results = await Promise.all(requests.map(({port, tx}) => post(port, tx)));

        const processed = results.filter((r) => r.status === 200 && r.body.status === 'PROCESSED');
        const rejected = results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS');
        expect({processed: processed.length, rejected: rejected.length}).toEqual({processed: 10, rejected: 20});
        // the database, not only the responses
        expect(await balanceOf(w.walletId)).toBe('0.00');
        expect(await count(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.walletId])).toBe(10);
        expect(await count(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'`, [w.walletId])).toBe(10);
        expect(await count(orm, `SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND status = 'REJECTED'`, [w.walletId])).toBe(20);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });

    it('30 requests with the same Idempotency-Key spread over the ports: one debit, 29 replays', async () => {
        const w = await openWallet();
        const tx = newTx(w);

        const results = await Promise.all(Array.from({length: 30}, (_, i) => post(ports[i % ports.length], tx)));

        expect(results.map((r) => r.status)).toEqual(Array(30).fill(200));
        expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
        expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
        expect(await balanceOf(w.walletId)).toBe('90.00');
        expect(await count(orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.walletId])).toBe(1);
        await assertLedgerMatchesBalance(orm, w.walletId);
    });
});

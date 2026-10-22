import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import {ReceiveMessageCommand} from '@aws-sdk/client-sqs';
import {afterAll, afterEach, beforeAll, beforeEach, expect} from 'vitest';
import {createOrm, resetSchema, truncateAll} from './db.js';
import {assertLedgerMatchesBalance} from './ledger.js';
import {createTestQueues, queueDepth, sleep, sqs} from './sqs.js';
import {dumpOutput, startInstances, type Instances, type TestQueues} from './instances.js';

// Polls instead of sleeping a fixed time: returns as soon as the state is reached, fails with `what` at the deadline.
export async function waitUntil(what: string, check: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 200): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
        await sleep(intervalMs);
    }
}

export const count = async (orm: MikroORM, sql: string, params: unknown[] = []) =>
    Number((await orm.em.getConnection().execute(`SELECT COUNT(*)::int AS n FROM (${sql}) q`, params))[0].n);

type Wallet = { walletId: string; playerId: string };
export interface Tx { key: string; body: Record<string, unknown> }

// A BET (or any kind) as a provider sends it. Each call is a new business transaction: its own key and external id.
export const newTx = (w: Wallet, amount = '10.00', kind = 'BET'): Tx => {
    const id = randomUUID();
    return {
        key: `key-${id}`,
        body: {providerId: 'prov-1', externalTransactionId: `ext-${id}`, playerId: w.playerId, walletId: w.walletId,
            roundId: 'round-1', gameId: 'game-1', kind, money: {amount, currency: 'BRL'}},
    };
};

// The same transaction as a queue message (README §10): the key travels inside `data`.
export const toMessage = (tx: Tx) => ({
    messageId: `msg-${randomUUID()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: {...tx.body, idempotencyKey: tx.key, walletId: tx.body.walletId as string},
});

export interface HttpResult { status: number; body: any }
export async function post(port: number, tx: Tx): Promise<HttpResult> {
    const res = await fetch(`http://localhost:${port}/wagering/transactions`, {
        method: 'POST', headers: {'content-type': 'application/json', 'idempotency-key': tx.key}, body: JSON.stringify(tx.body),
    });
    return {status: res.status, body: await res.json()};
}

// What a provider does when a call fails: same key, next instance, until an answer below 500 arrives.
export async function postWithRetry(ports: () => number[], tx: Tx, timeoutMs = 30_000): Promise<HttpResult> {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
        const live = ports();
        try {
            const result = await post(live[attempt % live.length], tx);
            if (result.status < 500) return result;
        } catch { /* connection refused or reset: the instance is gone */ }
        if (Date.now() > deadline) throw new Error(`no instance answered for ${tx.key}`);
        await sleep(100);
    }
}

export const sendInChunks = async <T>(items: T[], send: (item: T) => Promise<unknown>, chunk = 20) => {
    for (let i = 0; i < items.length; i += chunk) await Promise.all(items.slice(i, i + chunk).map(send));
};

// Everything README §13 wants true once the load is over: every business transaction stored exactly once and decided,
// nothing stuck, nothing unpublished, nothing left on the queues, and the ledger rebuilds every balance.
export async function waitForSettled(orm: MikroORM, queues: TestQueues, expectedTransactions: number, walletIds: string[]) {
    await waitUntil(`${expectedTransactions} stored transactions`, async () =>
        await count(orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`) >= expectedTransactions);
    await waitUntil('wager queue drained', async () => await queueDepth(queues.wagerQueueUrl) === 0);
    await waitUntil('outbox published', async () => await count(orm, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL') === 0);

    expect(await count(orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`), 'stored transactions').toBe(expectedTransactions);
    expect(await count(orm, `SELECT 1 FROM wager_transactions WHERE status NOT IN ('PROCESSED','REJECTED')`), 'transactions not decided').toBe(0);
    expect(await queueDepth(queues.wagerDlqUrl), 'DLQ').toBe(0);
    for (const id of walletIds) await assertLedgerMatchesBalance(orm, id);
}

// Duplicates on the events queue are fine, losses are not: compares the distinct eventIds with the outbox rows.
export async function expectEveryEventPublished(orm: MikroORM, eventsQueueUrl: string, timeoutMs = 60_000) {
    const expected = new Set<string>((await orm.em.getConnection().execute<{ id: string }[]>('SELECT id FROM outbox_messages')).map((r) => r.id));
    const seen = new Set<string>();
    await waitUntil(`${expected.size} distinct eventIds on the events queue (saw ${seen.size})`, async () => {
        const {Messages = []} = await sqs.send(new ReceiveMessageCommand({
            QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'],
        }));
        Messages.forEach((m) => seen.add(m.MessageAttributes!.eventId.StringValue!));
        return seen.size >= expected.size;
    }, timeoutMs, 0);
    expect(seen).toEqual(expected);
}

// Shared hooks of the queue-side specs: fresh schema, fresh throwaway queues, real instances. Call at the top level of a spec.
export function useMultiInstances(count = 3, extraEnv: Record<string, string> = {}) {
    const ctx = {} as { orm: MikroORM; queues: TestQueues };
    const started: Instances[] = [];
    beforeAll(async () => {
        ctx.orm = await createOrm();
        await resetSchema(ctx.orm);
        await ctx.orm.migrator.up();
    });
    beforeEach(async () => {
        await truncateAll(ctx.orm);
        ctx.queues = await createTestQueues();   // fresh per test: nothing left over hides behind a visibility timeout
    });
    afterEach(async (test) => {
        if (test.task.result?.state === 'fail') started.forEach(dumpOutput);
        await Promise.all(started.splice(0).map((i) => i.stop()));
    });
    afterAll(() => ctx.orm.close());
    // Started by the test (not a hook) because some tests seed data first or add a replacement later.
    const start = async (n = count) => {
        const instances = await startInstances(n, {queues: ctx.queues, extraEnv: {OUTBOX_POLL_MS: '200', ...extraEnv}});
        started.push(instances);
        return instances;
    };
    return Object.assign(ctx, {start});
}

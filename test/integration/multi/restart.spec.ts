import {describe, expect, it} from 'vitest';
import {openWallet} from '../../support/fixtures.js';
import {sendWagerMessage} from '../../support/sqs.js';
import {count, expectEveryEventPublished, newTx, type HttpResult, postWithRetry, sendInChunks, toMessage, useMultiInstances, waitForSettled, waitUntil} from '../../support/multi.js';

const t = useMultiInstances(3);

describe('restart: one instance is killed in the middle of the load', () => {
    it('SIGKILL mid-load and a replacement: nothing lost, nothing doubled, ledger intact', async () => {
        // 50.00 and BETs of 10.00: 5 PROCESSED and the rest INSUFFICIENT_FUNDS per wallet, so both outcomes cross the crash
        const wallets = await Promise.all(Array.from({length: 12}, () => openWallet(t.orm, '50.00')));
        const messageTxs = wallets.flatMap((w) => Array.from({length: 40}, () => newTx(w)));
        const httpTxs = wallets.flatMap((w) => Array.from({length: 8}, () => newTx(w)));
        const total = messageTxs.length + httpTxs.length;
        const instances = await t.start();
        const live = instances.map((i) => i.port);

        // The queue load and the HTTP load run together, in waves, while the test watches the database.
        // HTTP clients behave like providers: on a dropped connection they retry the SAME key on another instance.
        const httpResults: HttpResult[] = [];
        const load = Promise.all([
            sendInChunks(messageTxs, (tx) => sendWagerMessage(t.queues.wagerQueueUrl, toMessage(tx))),
            sendInChunks(httpTxs, async (tx) => { httpResults.push(await postWithRetry(() => live, tx)); }, 4),
        ]);

        // Kill when the first rows are stored, not after a fixed delay.
        await waitUntil('the first rows stored', async () => await count(t.orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`) >= 30, 30_000, 20);
        const victim = instances[0];
        victim.kill('SIGKILL');
        live.splice(live.indexOf(victim.port), 1);
        expect(await victim.exited).toBe(137);
        const storedAtKill = await count(t.orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`);
        expect(storedAtKill, 'the kill must land before the load is done, or this test proves nothing').toBeLessThan(total);

        live.push((await t.start(1))[0].port);       // the replacement
        await load;
        await waitForSettled(t.orm, t.queues, total, wallets.map((w) => w.walletId));   // includes the 2 s visibility timeout of what the victim held

        // 576 distinct business transactions in, 576 rows out: by idempotency key, none lost and none doubled.
        const keys = await t.orm.em.getConnection().execute<{ k: string; n: number }[]>(`SELECT idempotency_key AS k, COUNT(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING' GROUP BY 1`);
        expect(new Set(keys.map((r) => r.k))).toEqual(new Set([...messageTxs, ...httpTxs].map((tx) => tx.key)));
        expect(keys.every((r) => r.n === 1)).toBe(true);
        expect(httpResults).toHaveLength(httpTxs.length);
        expect(httpResults.every((r) => r.status === 200 || r.status === 422)).toBe(true);   // no 5xx reached the provider in the end
        expect(await count(t.orm, `SELECT 1 FROM wager_transactions WHERE status = 'PROCESSED' AND kind = 'BET'`)).toBe(12 * 5);
        await expectEveryEventPublished(t.orm, t.queues.eventsQueueUrl);   // the victim may have died between SendMessage and commit: duplicates fine, losses not
    });
});

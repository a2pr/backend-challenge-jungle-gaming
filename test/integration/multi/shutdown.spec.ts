import {describe, expect, it} from 'vitest';
import {openWallet} from '../../support/fixtures.js';
import {sendWagerMessage} from '../../support/sqs.js';
import {count, expectEveryEventPublished, newTx, sendInChunks, toMessage, useMultiInstances, waitForSettled, waitUntil} from '../../support/multi.js';

const t = useMultiInstances(3);

describe('SIGTERM on one instance while it handles messages', () => {
    it('it exits inside the grace period, nothing is lost and the others finish the work', async () => {
        const wallets = await Promise.all(Array.from({length: 12}, () => openWallet(t.orm, '50.00')));
        const txs = wallets.flatMap((w) => Array.from({length: 40}, () => newTx(w)));
        const instances = await t.start();

        const load = sendInChunks(txs, (tx) => sendWagerMessage(t.queues.wagerQueueUrl, toMessage(tx)));
        await waitUntil('the first rows stored', async () => await count(t.orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`) >= 30, 30_000, 20);
        const storedAtTerm = await count(t.orm, `SELECT 1 FROM wager_transactions WHERE kind <> 'OPENING'`);
        instances[0].kill('SIGTERM');

        // 143 = 128 + SIGTERM: NestJS re-raises the signal after its shutdown hooks finish (ARCHITECTURE.md, "Known limits").
        // Docker's default grace period is 10 s; the instance must be gone well inside it.
        const code = await Promise.race([instances[0].exited, new Promise<string>((resolve) => setTimeout(resolve, 10_000, 'still running after 10 s'))]);
        expect(code).toBe(143);
        expect(storedAtTerm, 'SIGTERM must land before the load is done').toBeLessThan(txs.length);

        await load;
        await waitForSettled(t.orm, t.queues, txs.length, wallets.map((w) => w.walletId));
        expect(await count(t.orm, `SELECT 1 FROM wager_transactions WHERE status = 'PROCESSED' AND kind = 'BET'`)).toBe(12 * 5);
        await expectEveryEventPublished(t.orm, t.queues.eventsQueueUrl);
    });
});

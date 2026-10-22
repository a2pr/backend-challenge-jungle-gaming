import {describe, expect, it} from 'vitest';
import {assertLedgerMatchesBalance} from '../../support/ledger.js';
import {openWallet} from '../../support/fixtures.js';
import {sendWagerMessage} from '../../support/sqs.js';
import {count, expectEveryEventPublished, newTx, post, sendInChunks, toMessage, useMultiInstances, waitForSettled} from '../../support/multi.js';

const t = useMultiInstances(3);

describe('queue consumers across 3 instances', () => {
    it('200 messages over 20 wallets: each processed once, no duplicated effect, queue and DLQ empty', async () => {
        // 50.00 and BETs of 10.00: 5 PROCESSED and 5 INSUFFICIENT_FUNDS per wallet, whatever the order across instances
        const wallets = await Promise.all(Array.from({length: 20}, () => openWallet(t.orm, '50.00')));
        const messages = wallets.flatMap((w) => Array.from({length: 10}, () => toMessage(newTx(w))));
        await t.start();

        await sendInChunks(messages, (m) => sendWagerMessage(t.queues.wagerQueueUrl, m));
        await waitForSettled(t.orm, t.queues, 200, wallets.map((w) => w.walletId));

        expect(await count(t.orm, `SELECT 1 FROM wager_transactions WHERE status = 'PROCESSED' AND kind = 'BET'`)).toBe(100);
        expect(await count(t.orm, `SELECT 1 FROM wager_transactions WHERE status = 'REJECTED'`)).toBe(100);
        expect(await count(t.orm, 'SELECT 1 FROM inbox_messages')).toBe(200);       // one inbox row per message
        expect(await count(t.orm, `SELECT 1 FROM wallets WHERE balance <> 0`)).toBe(0);
        expect(await count(t.orm, `SELECT 1 FROM wallet_ledger_entries WHERE direction = 'DEBIT'`)).toBe(100);
    });

    it('the same Idempotency-Key over HTTP on one instance and as an SQS message on others: one effect', async () => {
        const w = await openWallet(t.orm, '100.00');
        const instances = await t.start();
        const tx = newTx(w);

        // sent at the same time, so the two channels really race for the same wallet and key
        const [http] = await Promise.all([
            post(instances[0].port, tx),
            sendWagerMessage(t.queues.wagerQueueUrl, toMessage(tx)),
        ]);
        await waitForSettled(t.orm, t.queues, 1, [w.walletId]);

        expect(http.status).toBe(200);
        expect(await count(t.orm, `SELECT 1 FROM wager_transactions WHERE idempotency_key = ?`, [tx.key])).toBe(1);
        expect(await count(t.orm, `SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [w.walletId])).toBe(1);
        expect((await t.orm.em.getConnection().execute('SELECT balance::text AS b FROM wallets WHERE id = ?', [w.walletId]))[0].b).toBe('90.00');
        await assertLedgerMatchesBalance(t.orm, w.walletId);
        await expectEveryEventPublished(t.orm, t.queues.eventsQueueUrl);
    });
});

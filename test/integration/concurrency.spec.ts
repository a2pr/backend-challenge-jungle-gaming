import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, completed, openWallet, runInParallel} from '../support/fixtures.js';
import {SubmitWagerCommand, SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTransaction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';

let orm: MikroORM;
let useCase: SubmitWagerTransactionUseCase;

// Counts calls in flight at once. A max above 1 proves the calls really overlapped, not just ran one after another.
let inFlight = 0;
let maxInFlight = 0;
const submit = async (cmd: SubmitWagerCommand) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
        return completed(await useCase.execute(cmd));
    } finally {
        inFlight--;
    }
};

const balanceOf = async (walletId: string) =>
    (await orm.em.getConnection().execute('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b as string;

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    useCase = new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
});
afterAll(() => orm.close());
beforeEach(async () => {
    await truncateAll(orm);
    inFlight = maxInFlight = 0;
});

describe('concurrency', {timeout: 60_000}, () => {
    it('10a. hot wallet, 1000.00 and 200 BETs of 1.00: all PROCESSED, balance 800.00', async () => {
        const {walletId, playerId} = await openWallet(orm, '1000.00');

        const results = await runInParallel(200, () => submit(betCommand({walletId, playerId, money: brl('1.00')})));

        expect(maxInFlight).toBeGreaterThan(1);
        expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
        expect(await balanceOf(walletId)).toBe('800.00');
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('10b. hot wallet, 100.00 and 200 BETs of 1.00: exactly 100 PROCESSED, 100 INSUFFICIENT_FUNDS, balance 0.00', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');

        const results = await runInParallel(200, () => submit(betCommand({walletId, playerId, money: brl('1.00')})));

        expect(maxInFlight).toBeGreaterThan(1);
        expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(100);
        const rejected = results.filter((r) => r.status === 'REJECTED');
        expect(rejected).toHaveLength(100);
        expect(rejected.every((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
        expect(await balanceOf(walletId)).toBe('0.00');
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('11. 20 wallets with 10 BETs each in one Promise.all: no cross-talk', async () => {
        const wallets = await Promise.all(Array.from({length: 20}, () => openWallet(orm, '100.00')));

        const results = await Promise.all(wallets.flatMap(({walletId, playerId}) =>
            Array.from({length: 10}, () => submit(betCommand({walletId, playerId, money: brl('2.00')})))));

        expect(maxInFlight).toBeGreaterThan(1);
        expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
        for (const {walletId} of wallets) {
            expect(await balanceOf(walletId)).toBe('80.00');
            await assertLedgerMatchesBalance(orm, walletId);
        }
    });
});

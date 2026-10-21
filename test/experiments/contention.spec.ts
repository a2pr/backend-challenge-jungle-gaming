import {describe, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {EntityManager} from '@mikro-orm/core';
import config from '../../src/mikro-orm.config.js';
import {resetSchema} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, openWallet} from '../support/fixtures.js';
import {SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTransaction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';

// Test 15: D1 (pessimistic lock) with numbers. Not a pass/fail gate: a wrong balance is the only failure.
const out = (line: string) => process.stdout.write(line + '\n');
const BETS = 200;
const waits: number[] = [];

class TimedWalletRepository extends WalletRepository {
    override async lockById(em: EntityManager, id: string) {
        const start = performance.now();
        try {
            return await super.lockById(em, id);
        } finally {
            waits.push(performance.now() - start);
        }
    }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const ms = (n: number) => n.toFixed(0);

async function run(label: string, pool: number, walletCount: number) {
    const orm = await MikroORM.init({...config, pool: {min: 2, max: pool}});
    try {
        await resetSchema(orm);
        await orm.migrator.up();
        waits.length = 0;
        const useCase = new SubmitWagerTransactionUseCase(orm, new TimedWalletRepository(), new WagerTransactionRepository(),
            new WalletLedgerRepository(), new OutboxRepository(), new InboxRepository());
        const wallets = await Promise.all(Array.from({length: walletCount}, () => openWallet(orm, '100000.00')));

        const latencies: number[] = [];
        let timeouts = 0;
        let otherErrors = 0;
        let firstOther = '';
        const start = performance.now();
        await Promise.all(Array.from({length: BETS}, async (_, i) => {
            const {walletId, playerId} = wallets[i % walletCount];
            const t0 = performance.now();
            try {
                await useCase.execute(betCommand({walletId, playerId, money: brl('1.00')}));
            } catch (error) {
                if ((error as {code?: string}).code === '55P03') timeouts++; else { otherErrors++; firstOther ||= (error as Error).message; }
            }
            latencies.push(performance.now() - t0);
        }));
        const total = performance.now() - start;

        for (const {walletId} of wallets) await assertLedgerMatchesBalance(orm, walletId);
        const w = [...waits].sort((a, b) => a - b);
        const l = latencies.sort((a, b) => a - b);
        if (firstOther) out(`  (${label}: first non-timeout error: ${firstOther})`);
        const exhausted = pool < BETS && w.some((x) => x > 1000);
        out(`| ${label} | ${pool} | ${walletCount} | ${ms(total)} ms | ${(BETS / (total / 1000)).toFixed(0)} | ${ms(pct(w, 0.5))}/${ms(pct(w, 0.95))}/${ms(w[w.length - 1] ?? 0)} | ${ms(pct(l, 0.5))}/${ms(pct(l, 0.95))} | ${timeouts} | ${otherErrors} | ${exhausted ? 'yes' : 'no'} |`);
    } finally {
        await orm.close();
    }
}

describe('contention experiment (test 15)', () => {
    it('hot wallet vs spread wallets, three pool sizes', async () => {
        out('| run | pool | wallets | total | bets/s | lock wait p50/p95/max (ms) | call latency p50/p95 (ms) | lock_timeout | other errors | pool exhausted |');
        out('|---|---|---|---|---|---|---|---|---|---|');
        await run('1 hot', 10, 1);
        await run('2 hot', 60, 1);
        await run('3 hot', 90, 1);
        await run('3b hot', 200, 1);
        await run('4 baseline', 60, 200);
    });
});

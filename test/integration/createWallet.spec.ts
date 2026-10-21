import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {CreateWalletUseCase} from '../../src/wallet/createWallet.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTrasanction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {Test} from '@nestjs/testing';
import {AppModule} from '../../src/app.module.js';
import {DuplicateWalletError} from '../../src/wallet/errors.js';
import {InvalidMoneyError} from '../../src/money/errors.js';

let orm: MikroORM;
let createWallet: CreateWalletUseCase;

const count = async (table: string) =>
    Number((await orm.em.getConnection().execute(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const money = (amount: string, currency = 'BRL') => ({amount, currency});

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    createWallet = new CreateWalletUseCase(orm, new WalletRepository(), new WagerTransactionRepository(),
        new WalletLedgerRepository(), new OutboxRepository());
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('CreateWallet (test 13)', () => {
    it('13a. with a balance: wallet, OPENING transaction, ledger entry and two events together', async () => {
        const playerId = randomUUID();

        const result = await createWallet.execute({playerId, initialBalance: money('1000.00')});

        expect(result).toEqual({id: expect.any(String), playerId, balance: money('1000.00'), version: 1});
        const conn = orm.em.getConnection();
        const [opening] = await conn.execute('SELECT kind, status, balance_after::text AS balance_after FROM wager_transactions');
        expect(opening).toEqual({kind: 'OPENING', status: 'PROCESSED', balance_after: '1000.00'});
        const [entry] = await conn.execute(
            'SELECT direction, balance_before::text AS b, balance_after::text AS a FROM wallet_ledger_entries');
        expect(entry).toEqual({direction: 'CREDIT', b: '0.00', a: '1000.00'});
        const events = await conn.execute('SELECT event_type, aggregate_id FROM outbox_messages ORDER BY event_type');
        expect(events.map((e: any) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
        expect(events.every((e: any) => e.aggregate_id === result.id)).toBe(true);
        await assertLedgerMatchesBalance(orm, result.id);
    });

    it('13b. zero balance: only the wallet row, no transaction, ledger entry or events', async () => {
        const result = await createWallet.execute({playerId: randomUUID(), initialBalance: money('0.00')});

        expect(result).toMatchObject({balance: money('0.00'), version: 1});
        expect([await count('wallets'), await count('wager_transactions'),
            await count('wallet_ledger_entries'), await count('outbox_messages')]).toEqual([1, 0, 0, 0]);
    });

    it('13c. duplicate (player, currency) raises DuplicateWalletError and leaves nothing behind; another currency is fine', async () => {
        const playerId = randomUUID();
        await createWallet.execute({playerId, initialBalance: money('10.00')});

        await expect(createWallet.execute({playerId, initialBalance: money('99.00')})).rejects.toBeInstanceOf(DuplicateWalletError);

        expect([await count('wallets'), await count('wager_transactions'),
            await count('wallet_ledger_entries'), await count('outbox_messages')]).toEqual([1, 1, 1, 2]);
        await expect(createWallet.execute({playerId, initialBalance: money('5.00', 'USD')})).resolves.toMatchObject({version: 1});
    });

    it('13d. negative initial balance is rejected before anything is written', async () => {
        await expect(createWallet.execute({playerId: randomUUID(), initialBalance: money('-10.00')}))
            .rejects.toBeInstanceOf(InvalidMoneyError);

        expect([await count('wallets'), await count('wager_transactions'),
            await count('wallet_ledger_entries'), await count('outbox_messages')]).toEqual([0, 0, 0, 0]);
    });
});

describe('Nest wiring', () => {
    it('AppModule resolves CreateWalletUseCase with all its dependencies', async () => {
        const module = await Test.createTestingModule({imports: [AppModule]}).compile();
        try {
            expect(module.get(CreateWalletUseCase)).toBeInstanceOf(CreateWalletUseCase);
        } finally {
            await module.close();
        }
    });
});

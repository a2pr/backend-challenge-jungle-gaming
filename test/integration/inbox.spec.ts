import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {assertLedgerMatchesBalance} from '../support/ledger.js';
import {betCommand, brl, completed, openWallet, runInParallel} from '../support/fixtures.js';
import {SubmitWagerTransactionUseCase} from '../../src/wager/SubmitWagerTransaction.usecase.js';
import {WalletRepository} from '../../src/wallet/wallet.repository.js';
import {WagerTransactionRepository} from '../../src/wager/wagerTrasanction.repository.js';
import {WalletLedgerRepository} from '../../src/wallet/walletLedger.repository.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';
import {InboxRepository} from '../../src/messaging/inbox.repository.js';
import {WagerTransactionKind} from '../../src/wager/wagerTransactionKind.js';
import {WalletNotFoundError} from '../../src/wager/errors.js';

let orm: MikroORM;
let submit: SubmitWagerTransactionUseCase;

class FailingOutbox extends OutboxRepository {
    override async enqueue(): Promise<void> { throw new Error('outbox down'); }
}
class FailingLedger extends WalletLedgerRepository {
    override async insert(): Promise<void> { throw new Error('ledger down'); }
}
const build = (outbox = new OutboxRepository(), ledger = new WalletLedgerRepository()) =>
    new SubmitWagerTransactionUseCase(orm, new WalletRepository(), new WagerTransactionRepository(), ledger, outbox, new InboxRepository());

const rows = (sql: string, params: unknown[] = []) => orm.em.getConnection().execute(sql, params);
const count = async (table: string) => Number((await rows(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
const balanceOf = async (walletId: string) => (await rows('SELECT balance::text AS b FROM wallets WHERE id = ?', [walletId]))[0].b;
const inboxRows = (messageId: string) =>
    rows('SELECT consumer_name, processed_at FROM inbox_messages WHERE message_id = ? ORDER BY consumer_name', [messageId]);
const message = (messageId = randomUUID(), consumerName = 'wager-consumer') => ({consumerName, messageId, payloadHash: 'hash-1'});
const debits = async (walletId: string) =>
    Number((await rows(`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0].n);

beforeAll(async () => {
    orm = await createOrm();
    await resetSchema(orm);
    await orm.migrator.up();
    submit = build();
});
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('SubmitWagerTransaction: atomicity (test 12)', () => {
    // Everything the call would have written: wallet balance, transaction, ledger, outbox, inbox.
    const snapshot = async (walletId: string) =>
        [await balanceOf(walletId), await count('wager_transactions'), await count('wallet_ledger_entries'),
            await count('outbox_messages'), await count('inbox_messages')];

    it('12a. an outbox failure rolls back the wallet, transaction, ledger and inbox rows', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const before = await snapshot(walletId);

        await expect(build(new FailingOutbox()).execute(betCommand({walletId, playerId, money: brl('30.00')}), {inbox: message()}))
            .rejects.toThrow('outbox down');

        expect(await snapshot(walletId)).toEqual(before);
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('12b. a ledger failure after the wallet save rolls the wallet update back too', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const before = await snapshot(walletId);

        await expect(build(undefined, new FailingLedger()).execute(betCommand({walletId, playerId, money: brl('30.00')}), {inbox: message()}))
            .rejects.toThrow('ledger down');

        expect(await snapshot(walletId)).toEqual(before);
        expect(await balanceOf(walletId)).toBe('100.00');
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('12c. after a rollback the same message is processed normally on redelivery', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('30.00')});
        const msg = message();
        await expect(build(new FailingOutbox()).execute(cmd, {inbox: msg})).rejects.toThrow('outbox down');

        const retry = await submit.execute(cmd, {inbox: msg});

        expect(retry).toMatchObject({kind: 'completed', status: 'PROCESSED', balance: {amount: '70.00'}});
        expect(await debits(walletId)).toBe(1);
        await assertLedgerMatchesBalance(orm, walletId);
    });
});

describe('SubmitWagerTransaction: inbox (test 14)', () => {
    it('14a. the same message twice: second is duplicate-message, one debit, inbox row processed', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('30.00')});
        const msg = message();

        const first = await submit.execute(cmd, {inbox: msg});
        const second = await submit.execute(cmd, {inbox: msg});

        expect(first).toMatchObject({kind: 'completed', status: 'PROCESSED', idempotentReplay: false});
        expect(second).toEqual({kind: 'duplicate-message'});
        expect(await debits(walletId)).toBe(1);
        expect(await balanceOf(walletId)).toBe('70.00');
        const [row, ...rest] = await inboxRows(msg.messageId);
        expect(rest).toHaveLength(0);
        expect(row.processed_at).not.toBeNull();
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('14b. a use case that throws leaves no inbox row', async () => {
        const msg = message();
        await expect(submit.execute(betCommand({walletId: randomUUID(), playerId: randomUUID()}), {inbox: msg}))
            .rejects.toBeInstanceOf(WalletNotFoundError);
        expect(await inboxRows(msg.messageId)).toHaveLength(0);
    });

    it('14c. the same message in parallel: one completed, one duplicate-message, one debit', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('30.00')});
        const msg = message();

        const results = await runInParallel(2, () => submit.execute(cmd, {inbox: msg}));

        expect(results.map((r) => r.kind).sort()).toEqual(['completed', 'duplicate-message']);
        expect(await debits(walletId)).toBe(1);
        expect((await inboxRows(msg.messageId))[0].processed_at).not.toBeNull();
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('14d. a business rejection and an idempotent replay both complete and mark the inbox row', async () => {
        const {walletId, playerId} = await openWallet(orm, '10.00');
        const cmd = betCommand({walletId, playerId, money: brl('50.00')});
        const rejectedMsg = message();
        const replayMsg = message();

        const rejected = completed(await submit.execute(cmd, {inbox: rejectedMsg}));
        const replay = completed(await submit.execute(cmd, {inbox: replayMsg}));

        expect(rejected).toMatchObject({status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false});
        expect(replay).toEqual({...rejected, idempotentReplay: true});
        for (const m of [rejectedMsg, replayMsg]) expect((await inboxRows(m.messageId))[0].processed_at).not.toBeNull();
        await assertLedgerMatchesBalance(orm, walletId);
    });

    it('14e. a new message carrying an already used idempotency key is a replay, not a second debit', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const cmd = betCommand({walletId, playerId, money: brl('30.00'), kind: WagerTransactionKind.Bet});

        await submit.execute(cmd, {inbox: message()});
        const again = await submit.execute(cmd, {inbox: message()});

        expect(again).toMatchObject({kind: 'completed', idempotentReplay: true});
        expect(await debits(walletId)).toBe(1);
        expect(await count('inbox_messages')).toBe(2);
    });

    it('14f. the same message id is new for another consumer', async () => {
        const {walletId, playerId} = await openWallet(orm, '100.00');
        const id = randomUUID();

        const a = await submit.execute(betCommand({walletId, playerId}), {inbox: message(id, 'consumer-a')});
        const b = await submit.execute(betCommand({walletId, playerId}), {inbox: message(id, 'consumer-b')});

        expect([a.kind, b.kind]).toEqual(['completed', 'completed']);
        expect(await inboxRows(id)).toHaveLength(2);
    });
});

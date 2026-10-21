import {describe, expect, it} from 'vitest';
import Money from '../../src/money/money.js';
import Wallet from '../../src/wallet/wallet.js';
import {WalletBalanceChanged} from '../../src/events/walletBalanceChanged.js';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const brl = (amount: string) => Money.from({amount, currency: 'BRL'});
const ctx = {eventId: 'ev-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: t0};

describe('WalletBalanceChanged', () => {
    it('serialises the README §11 envelope with MoneyProps strings', () => {
        const wallet = Wallet.open({id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: t0});
        const entry = wallet.debit(brl('80.00'), {entryId: 'e1', transactionId: 't1', now: t0});

        const json = JSON.parse(JSON.stringify(WalletBalanceChanged.from(wallet, entry, ctx)));

        expect(json).toEqual({
            eventId: 'ev-1', eventType: 'WalletBalanceChanged', aggregateId: 'w1',
            correlationId: 'corr-1', causationId: 'cause-1', occurredAt: '2026-01-01T00:00:00.000Z', version: 1,
            data: {
                walletId: 'w1', transactionId: 't1', direction: 'DEBIT',
                money: {amount: '80.00', currency: 'BRL'},
                balanceBefore: {amount: '100.00', currency: 'BRL'},
                balanceAfter: {amount: '20.00', currency: 'BRL'},
                walletVersion: 2,   // open = 1, the debit made it 2
            },
        });
    });

    it('leaves causationId out when there is none', () => {
        const wallet = Wallet.open({id: 'w1', playerId: 'p1', initialBalance: brl('10.00'), now: t0});
        const entry = wallet.credit(brl('1.00'), {entryId: 'e1', transactionId: 't1', now: t0});
        const {causationId: _omit, ...noCause} = ctx;

        const json = JSON.parse(JSON.stringify(WalletBalanceChanged.from(wallet, entry, noCause)));
        expect('causationId' in json).toBe(false);
    });
});

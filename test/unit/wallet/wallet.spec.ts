import { describe, expect, it } from 'vitest';
import Money from '../../../src/money/money.js';
import { CurrencyMismatchError } from '../../../src/money/errors.js';
import Wallet from '../../../src/wallet/wallet.js';
import { LedgerDirection } from '../../../src/wallet/walletLedgerEntry.js';
import { InsufficientFundsError, InvalidMovementError } from '../../../src/wallet/errors.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
// Money.from rejects negatives, so negative values come from negate()
const neg = (amount: string) => brl(amount).negate();

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:10Z');
let n = 0;
const ctx = (now = t1) => ({ entryId: `entry-${++n}`, transactionId: `tx-${n}`, now });

const open = (balance = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(balance), now: t0 });

describe('Wallet.open', () => {
  it('starts at version 1 with the given balance and clock', () => {
    const w = open('1000.00');
    expect(w.balance.toString()).toBe('1000.00');
    expect(w.currency).toBe('BRL');
    expect(w.version).toBe(1);
    expect(w.createdAt).toEqual(t0);
    expect(w.updatedAt).toEqual(t0);
  });

  it('allows a zero balance', () => {
    expect(open('0.00').balance.isZero()).toBe(true);
  });

  it('rejects a negative balance', () => {
    expect(() =>
      Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: neg('1.00'), now: t0 }),
    ).toThrow(InvalidMovementError);
  });
});

describe('Wallet.rehydrate', () => {
  it('restores every field as stored, version included', () => {
    const w = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: t0,
      updatedAt: t1,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe('42.00');
    expect(w.createdAt).toEqual(t0);
    expect(w.updatedAt).toEqual(t1);
  });
});

describe('Wallet.debit', () => {
  it('moves the balance, bumps the version and returns a balanced DEBIT entry', () => {
    const w = open('100.00');
    const c = ctx();
    const e = w.debit(brl('80.00'), c);

    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(t1);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.toString()).toBe('100.00');
    expect(e.balanceAfter.toString()).toBe('20.00');
    expect(e.money.toString()).toBe('80.00');
    expect(e.isBalanced()).toBe(true);
  });

  it('takes walletId from the wallet and ids and clock from the context', () => {
    const c = ctx();
    const e = open().debit(brl('1.00'), c);
    expect(e.walletId).toBe('w1');
    expect(e.id).toBe(c.entryId);
    expect(e.transactionId).toBe(c.transactionId);
    expect(e.createdAt).toEqual(c.now);
  });

  it('throws InsufficientFundsError and leaves balance, version and updatedAt untouched', () => {
    const w = open('100.00');
    w.debit(brl('80.00'), ctx());
    const before = { balance: w.balance.toString(), version: w.version, updatedAt: w.updatedAt };

    let error: unknown;
    try {
      w.debit(brl('80.00'), ctx(new Date('2026-01-02T00:00:00Z')));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InsufficientFundsError);
    const err = error as InsufficientFundsError;
    expect(err.name).toBe('InsufficientFundsError');
    expect(err.balance.toString()).toBe('20.00');
    expect(err.requested.toString()).toBe('80.00');
    expect({ balance: w.balance.toString(), version: w.version, updatedAt: w.updatedAt }).toEqual(
      before,
    );
  });

  it('allows a debit down to exactly 0.00', () => {
    const w = open('20.00');
    w.debit(brl('20.00'), ctx());
    expect(w.balance.isZero()).toBe(true);
    expect(w.version).toBe(2);
  });

  it('throws CurrencyMismatchError for another currency and changes nothing', () => {
    const w = open('100.00');
    expect(() => w.debit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  it.each([
    ['zero', brl('0.00')],
    ['negative', neg('1.00')],
  ])('throws InvalidMovementError for a %s amount and changes nothing', (_label, money) => {
    const w = open('100.00');
    expect(() => w.debit(money, ctx())).toThrow(InvalidMovementError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(t0);
  });
});

describe('Wallet.credit', () => {
  it('moves the balance, bumps the version and returns a balanced CREDIT entry', () => {
    const w = open('0.00');
    const e = w.credit(brl('5.00'), ctx());

    expect(w.balance.toString()).toBe('5.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.balanceBefore.toString()).toBe('0.00');
    expect(e.balanceAfter.toString()).toBe('5.00');
    expect(e.isBalanced()).toBe(true);
  });

  it('throws CurrencyMismatchError for another currency and changes nothing', () => {
    const w = open('100.00');
    expect(() => w.credit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  it.each([
    ['zero', brl('0.00')],
    ['negative', neg('1.00')],
  ])('throws InvalidMovementError for a %s amount and changes nothing', (_label, money) => {
    const w = open('100.00');
    expect(() => w.credit(money, ctx())).toThrow(InvalidMovementError);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('Wallet movements together', () => {
  it('credit then debit of the same amount returns to the start, version +2', () => {
    const w = open('100.00');
    w.credit(brl('30.00'), ctx());
    w.debit(brl('30.00'), ctx());
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(3);
  });

  it('ten movements bump the version by ten and chain the entries', () => {
    const w = open('100.00');
    const entries = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0 ? w.debit(brl('10.00'), ctx()) : w.credit(brl('5.00'), ctx()),
    );

    expect(w.version).toBe(11);
    entries.forEach((e, i) => {
      expect(e.isBalanced()).toBe(true);
      if (i > 0) expect(e.balanceBefore.equals(entries[i - 1].balanceAfter)).toBe(true);
    });
    expect(entries[0].balanceBefore.toString()).toBe('100.00');
    expect(entries[9].balanceAfter.toString()).toBe(w.balance.toString());
  });
});

describe('Wallet.openingEntry', () => {
  it('is undefined for a zero balance', () => {
    expect(open('0.00').openingEntry(ctx())).toBeUndefined();
  });

  it('returns a CREDIT from 0.00 to the opening balance without changing the wallet', () => {
    const w = open('1000.00');
    const c = ctx();
    const e = w.openingEntry(c)!;

    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.money.toString()).toBe('1000.00');
    expect(e.balanceBefore.toString()).toBe('0.00');
    expect(e.balanceAfter.toString()).toBe('1000.00');
    expect(e.isBalanced()).toBe(true);
    expect(e.walletId).toBe('w1');
    expect(e.id).toBe(c.entryId);
    expect(e.transactionId).toBe(c.transactionId);
    expect(e.createdAt).toEqual(c.now);

    expect(w.balance.toString()).toBe('1000.00');
    expect(w.version).toBe(1);
    expect(w.updatedAt).toEqual(t0);
  });

  it('throws once the wallet has moved (it would fabricate history)', () => {
    const w = open('100.00');
    w.debit(brl('10.00'), ctx());
    expect(() => w.openingEntry(ctx())).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import Money from '../../../src/money/money.js';
import { CurrencyMismatchError } from '../../../src/money/errors.js';
import WalletLedgerEntry, {
  CreateLedgerEntryProps,
  LedgerDirection,
} from '../../../src/wallet/walletLedgerEntry.js';
import { InvalidMovementError } from '../../../src/wallet/errors.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
// Money.from rejects negatives, so negative values come from negate()
const neg = (amount: string) => brl(amount).negate();
const now = new Date('2026-01-01T00:00:00Z');

const props = (over: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  now,
  ...over,
});

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced DEBIT and keeps every field', () => {
    const e = WalletLedgerEntry.create(props());
    expect(e.id).toBe('entry-1');
    expect(e.walletId).toBe('wallet-1');
    expect(e.transactionId).toBe('tx-1');
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.money.toString()).toBe('25.00');
    expect(e.balanceBefore.toString()).toBe('100.00');
    expect(e.balanceAfter.toString()).toBe('75.00');
    expect(e.createdAt).toEqual(now);
    expect(e.isBalanced()).toBe(true);
  });

  it('accepts a balanced CREDIT', () => {
    const e = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') }),
    );
    expect(e.isBalanced()).toBe(true);
  });

  it('accepts a debit down to exactly 0.00', () => {
    const e = WalletLedgerEntry.create(
      props({ money: brl('100.00'), balanceAfter: brl('0.00') }),
    );
    expect(e.balanceAfter.isZero()).toBe(true);
  });

  it('accepts a credit from a 0.00 balance', () => {
    const e = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('0.00'),
        balanceAfter: brl('25.00'),
      }),
    );
    expect(e.isBalanced()).toBe(true);
  });

  it('rejects a DEBIT whose arithmetic does not match (100.00 - 25.00 != 70.00)', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('70.00') }))).toThrow(
      InvalidMovementError,
    );
  });

  it('rejects a CREDIT that carries the arithmetic of a debit', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
    ).toThrow(InvalidMovementError);
  });

  it.each([
    ['zero', brl('0.00')],
    ['negative', neg('5.00')],
  ])('rejects a %s amount', (_label, money) => {
    expect(() =>
      WalletLedgerEntry.create(props({ money, balanceAfter: brl('100.00') })),
    ).toThrow(InvalidMovementError);
  });

  it('rejects a negative balanceAfter (debit 101.00 from 100.00)', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('101.00'), balanceAfter: neg('1.00') })),
    ).toThrow(InvalidMovementError);
  });

  it('rejects a negative balanceBefore', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceBefore: neg('10.00'),
          balanceAfter: brl('15.00'),
        }),
      ),
    ).toThrow(InvalidMovementError);
  });

  it('rejects mixed currencies with InvalidMovementError, not CurrencyMismatchError', () => {
    const bad = props({ balanceBefore: usd('100.00'), balanceAfter: usd('75.00') });
    expect(() => WalletLedgerEntry.create(bad)).toThrow(InvalidMovementError);
    expect(() => WalletLedgerEntry.create(bad)).not.toThrow(CurrencyMismatchError);
  });

  it('rejects when only money differs in currency from the balances', () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd('25.00') }))).toThrow(
      InvalidMovementError,
    );
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  const state = (over = {}) => ({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: now,
    ...over,
  });

  it('restores every field as stored', () => {
    const e = WalletLedgerEntry.rehydrate(state());
    expect(e.id).toBe('entry-1');
    expect(e.createdAt).toEqual(now);
    expect(e.isBalanced()).toBe(true);
  });

  it('does not validate: an unbalanced state loads and reports isBalanced() false', () => {
    const e = WalletLedgerEntry.rehydrate(state({ balanceAfter: brl('70.00') }));
    expect(e.isBalanced()).toBe(false);
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('has no way to change a field', () => {
    const e = WalletLedgerEntry.create(props());
    // @ts-expect-error fields are readonly: this line compiles only if that is true
    e.walletId = 'other';
  });
});

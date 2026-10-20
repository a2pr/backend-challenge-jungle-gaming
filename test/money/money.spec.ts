import { describe, expect, it } from 'vitest';
import Money from '../../src/money/money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from / zero', () => {
  it('builds from a decimal string and keeps scale 2', () => {
    expect(brl('25.00').toString()).toBe('25.00');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('zero() is 0.00 in the given currency', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  it.each([
    '',
    'NaN',
    'Infinity',
    '1e3',
    '1E3',
    '25',
    '25.0',
    '1.005',
    '1,00',
    '.50',
    ' 1.00',
    '1.00 ',
    'abc',
  ])('rejects invalid amount %j', (amount) => {
    expect(() => brl(amount)).toThrow();
  });

  it.each(['', 'br', 'BRLL', 'brl', 'B1L'])(
    'rejects invalid currency %j',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow();
      expect(() => Money.zero(currency)).toThrow();
    },
  );

  it('round-trips through toJSON', () => {
    const m = brl('123456789.99');
    expect(Money.from(m.toJSON()).equals(m)).toBe(true);
  });
});

describe('arithmetic', () => {
  it('is exact where floats are not (0.1 + 0.2)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('adds and subtracts', () => {
    expect(brl('10.00').add(brl('5.50')).toString()).toBe('15.50');
    expect(brl('10.00').subtract(brl('5.50')).toString()).toBe('4.50');
  });

  it('subtract can go negative', () => {
    expect(brl('1.00').subtract(brl('2.50')).toString()).toBe('-1.50');
  });

  it('negate flips the sign and is its own inverse', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('25.00').negate().negate().toString()).toBe('25.00');
  });

  it('negate of zero is "0.00", not "-0.00"', () => {
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });

  it('accepts "-0.00" as input but prints "0.00"', () => {
    expect(brl('-0.00').toString()).toBe('0.00');
  });

  it('does not lose precision on large values', () => {
    expect(brl('999999999999999999.99').add(brl('0.01')).toString()).toBe(
      '1000000000000000000.00',
    );
  });
});

describe('immutability', () => {
  it('every operation returns a new instance and leaves the original untouched', () => {
    const a = brl('10.00');
    const b = brl('2.00');

    for (const r of [a.add(b), a.subtract(b), a.negate()]) {
      expect(r).not.toBe(a);
    }
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('2.00');
  });
});

describe('predicates', () => {
  it('isZero / isPositive / isNegative', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);

    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);

    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('-0.01').isPositive()).toBe(false);
    expect(brl('-0.01').isZero()).toBe(false);
  });

  it('isLessThan', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('-1.00').isLessThan(brl('0.00'))).toBe(true);
  });

  it('equals compares value, not representation', () => {
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
    expect(brl('0.00').equals(Money.zero('BRL'))).toBe(true);
  });
});

describe('currency mismatch', () => {
  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ['equals', (a: Money, b: Money) => a.equals(b)],
  ])('%s throws for BRL vs USD', (_name, op) => {
    expect(() => op(brl('1.00'), usd('1.00'))).toThrow();
  });
});

describe('serialization', () => {
  it('JSON.stringify uses toJSON', () => {
    expect(JSON.stringify({ price: brl('25.00') })).toBe(
      '{"price":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  it('never emits scientific notation', () => {
    expect(brl('100000000000000000000000.00').toString()).toBe(
      '100000000000000000000000.00',
    );
  });
});

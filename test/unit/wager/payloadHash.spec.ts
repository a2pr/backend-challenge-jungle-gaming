import { describe, expect, it } from 'vitest';
import Money from '../../../src/money/money.js';
import { canonicalJson, payloadHash, PayloadFields } from '../../../src/wager/payloadHash.js';
import { WagerTransactionKind } from '../../../src/wager/wagerTransactionKind.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const base: PayloadFields = {
  providerId: 'p',
  externalTransactionId: 'e',
  playerId: 'pl',
  walletId: 'w',
  roundId: 'r',
  gameId: 'g',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
};

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }, 1] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1},1],"d":2},"b":1}',
    );
  });

  it('drops undefined properties but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('converts through toJSON first (Money)', () => {
    expect(canonicalJson(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });
});

describe('payloadHash', () => {
  const hash = payloadHash(base);

  it('is 64 hex characters and deterministic', () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ ...base })).toBe(hash);
  });

  it('GOLDEN: a fixed input gives this literal hash (change = every stored replay becomes a 409)', () => {
    expect(hash).toBe('b1d776f3a9c76c35d611f733eedbb191f074633cba3ae074b2a33c7d11dfb09c');
  });

  it('does not depend on property order', () => {
    const reordered: PayloadFields = {
      money: brl('25.00'),
      kind: WagerTransactionKind.Bet,
      gameId: 'g',
      roundId: 'r',
      walletId: 'w',
      playerId: 'pl',
      externalTransactionId: 'e',
      providerId: 'p',
    };
    expect(payloadHash(reordered)).toBe(hash);
  });

  it('treats an undefined reference like an absent one', () => {
    expect(payloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(hash);
  });

  it('ignores properties outside the nine fields (idempotencyKey)', () => {
    const withKey = { ...base, idempotencyKey: 'abc' } as PayloadFields;
    expect(payloadHash(withKey)).toBe(hash);
  });

  it.each([
    ['providerId', 'other'],
    ['externalTransactionId', 'other'],
    ['playerId', 'other'],
    ['walletId', 'other'],
    ['roundId', 'other'],
    ['gameId', 'other'],
    ['kind', WagerTransactionKind.Win],
    ['money', brl('25.01')],
    ['money', Money.from({ amount: '25.00', currency: 'USD' })],
    ['referenceExternalTransactionId', 'ref-1'],
  ])('changing %s changes the hash', (field, value) => {
    expect(payloadHash({ ...base, [field]: value })).not.toBe(hash);
  });
});

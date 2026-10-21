import { describe, expect, it } from 'vitest';
import Money from '../../../src/money/money.js';
import WagerTransaction, {
  CreateWagerTransactionProps,
  WagerTransactionState,
} from '../../../src/wager/wagerTransaction.js';
import { WagerTransactionKind as Kind } from '../../../src/wager/wagerTransactionKind.js';
import { WagerTransactionStatus as Status } from '../../../src/wager/wagerTransactionStatus.js';
import { FailureCode } from '../../../src/wager/failureCode.js';
import { LedgerDirection } from '../../../src/wallet/walletLedgerEntry.js';
import { payloadHash } from '../../../src/wager/payloadHash.js';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/wager/errors.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
// Money.from rejects negatives, so negative values come from negate()
const neg = (amount: string) => brl(amount).negate();

const t0 = new Date('2026-01-01T00:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

const props = (o: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'prov-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  kind: Kind.Bet,
  money: brl('25.00'),
  now: t0,
  ...o,
});

const makeProcessedBet = () => {
  const tx = WagerTransaction.create(props());
  tx.markProcessed(undefined, at(1));
  return tx;
};

const needsRef = (kind: Kind) => kind === Kind.Refund || kind === Kind.Rollback;
// a valid transaction of any kind, with a reference when the kind requires one
const make = (kind: Kind, o: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(
    props({
      kind,
      ...(needsRef(kind) ? { referenceExternalTransactionId: 'ext-ref' } : {}),
      ...o,
    }),
  );

const inState = (s: 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED') => {
  const tx = WagerTransaction.create(props());
  if (s === 'PENDING_REFERENCE') tx.markPendingReference(t0);
  if (s === 'PROCESSED') tx.markProcessed(undefined, at(1));
  if (s === 'REJECTED') tx.reject(FailureCode.InsufficientFunds);
  if (s === 'FAILED') tx.fail(FailureCode.ProcessingError);
  return tx;
};

const snapshot = (tx: WagerTransaction) => ({
  status: tx.status,
  attempts: tx.attempts,
  nextAttemptAt: tx.nextAttemptAt,
  processedAt: tx.processedAt,
  failureCode: tx.failureCode,
  referenceTransactionId: tx.referenceTransactionId,
});

describe('WagerTransaction.rehydrate (7.1)', () => {
  const base: WagerTransactionState = {
    id: 'tx-1',
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: Kind.Refund,
    money: brl('25.00'),
    referenceExternalTransactionId: 'ext-ref',
    createdAt: t0,
    status: Status.Pending,
    attempts: 0,
  };

  it('round-trips a processed state', () => {
    const tx = WagerTransaction.rehydrate({
      ...base,
      status: Status.Processed,
      processedAt: at(5),
      referenceTransactionId: 'internal-9',
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(at(5));
    expect(tx.referenceTransactionId).toBe('internal-9');
    expect(tx.id).toBe('tx-1');
    expect(tx.payloadHash).toBe('a'.repeat(64));
    expect(tx.kind).toBe(Kind.Refund);
    expect(tx.money.toString()).toBe('25.00');
    expect(tx.createdAt).toEqual(t0);
  });

  it('keeps attempts and nextAttemptAt', () => {
    const tx = WagerTransaction.rehydrate({
      ...base,
      status: Status.PendingReference,
      attempts: 2,
      nextAttemptAt: at(140),
    });
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt).toEqual(at(140));
  });

  it('does not validate (stored data is trusted)', () => {
    expect(() => WagerTransaction.rehydrate({ ...base, kind: Kind.Bet, money: neg('1.00') })).not.toThrow();
  });
});

describe('WagerTransaction.create: reference and amount rules (7.2)', () => {
  const REF = 'ext-ref';
  const rows: [string, Kind, string | undefined, () => Money, 'created' | RegExp][] = [
    ['1 BET 25.00', Kind.Bet, undefined, () => brl('25.00'), 'created'],
    ['2 BET with reference', Kind.Bet, REF, () => brl('25.00'), /BET/],
    ['3 BET 0.00', Kind.Bet, undefined, () => brl('0.00'), /BET/],
    ['4 BET -1.00', Kind.Bet, undefined, () => neg('1.00'), /BET/],
    ['5 WIN 50.00', Kind.Win, undefined, () => brl('50.00'), 'created'],
    ['6 WIN 50.00 with reference', Kind.Win, REF, () => brl('50.00'), 'created'],
    ['7 WIN 0.00', Kind.Win, undefined, () => brl('0.00'), /WIN/],
    ['8 WIN -1.00', Kind.Win, undefined, () => neg('1.00'), /WIN/],
    ['9 LOSS 0.00', Kind.Loss, undefined, () => brl('0.00'), 'created'],
    ['10 LOSS 0.00 with reference', Kind.Loss, REF, () => brl('0.00'), 'created'],
    ['11 LOSS 5.00', Kind.Loss, undefined, () => brl('5.00'), 'created'],
    ['12 LOSS -1.00', Kind.Loss, undefined, () => neg('1.00'), /LOSS/],
    ['13 REFUND without reference', Kind.Refund, undefined, () => brl('25.00'), /REFUND/],
    ['14 REFUND with reference', Kind.Refund, REF, () => brl('25.00'), 'created'],
    ['15 REFUND 0.00 with reference', Kind.Refund, REF, () => brl('0.00'), /REFUND/],
    ['16 ROLLBACK without reference', Kind.Rollback, undefined, () => brl('25.00'), /ROLLBACK/],
    ['17 ROLLBACK with reference', Kind.Rollback, REF, () => brl('25.00'), 'created'],
    ['18 ROLLBACK 0.00 with reference', Kind.Rollback, REF, () => brl('0.00'), /ROLLBACK/],
    ['19 OPENING 1000.00', Kind.Opening, undefined, () => brl('1000.00'), 'created'],
    ['20 OPENING with reference', Kind.Opening, REF, () => brl('1000.00'), /OPENING/],
    ['21 OPENING 0.00', Kind.Opening, undefined, () => brl('0.00'), /OPENING/],
    ['REFUND -1.00 with reference', Kind.Refund, REF, () => neg('1.00'), /REFUND/],
    ['ROLLBACK 0.00 without reference', Kind.Rollback, undefined, () => brl('0.00'), /ROLLBACK/],
    ['WIN 0.00 with reference', Kind.Win, REF, () => brl('0.00'), /WIN/],
    ['LOSS 5.00 with reference', Kind.Loss, REF, () => brl('5.00'), 'created'],
    ['OPENING 0.00 with reference', Kind.Opening, REF, () => brl('0.00'), /OPENING/],
  ];

  it.each(rows)('%s', (_label, kind, reference, money, expected) => {
    const create = () =>
      WagerTransaction.create(props({ kind, money: money(), referenceExternalTransactionId: reference }));
    if (expected === 'created') {
      expect(create()).toBeInstanceOf(WagerTransaction);
    } else {
      expect(create).toThrow(InvalidWagerTransactionError);
      expect(create).toThrow(expected);
    }
  });

  it('LOSS does not affect the balance, REFUND requires a reference', () => {
    expect(make(Kind.Loss, { money: brl('0.00') }).affectsBalance()).toBe(false);
    expect(make(Kind.Refund).requiresReference()).toBe(true);
  });
});

describe('WagerTransaction.create: blank fields (7.2)', () => {
  const fields = [
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ] as const;

  it.each(fields.flatMap((f) => [[f, ''] as const, [f, '   '] as const]))(
    '%s = %j is rejected and named',
    (field, value) => {
      const create = () => WagerTransaction.create(props({ [field]: value }));
      expect(create).toThrow(InvalidWagerTransactionError);
      expect(create).toThrow(field);
    },
  );

  it('an empty referenceExternalTransactionId is not "absent"', () => {
    const create = () => WagerTransaction.create(props({ kind: Kind.Win, referenceExternalTransactionId: '' }));
    expect(create).toThrow(InvalidWagerTransactionError);
    expect(create).toThrow('referenceExternalTransactionId');
  });
});

describe('WagerTransaction.create: what a new transaction has set (7.2)', () => {
  it('is PENDING with every field copied and the hash computed', () => {
    const p = props();
    const tx = WagerTransaction.create(p);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.createdAt).toEqual(t0);
    expect(tx.idempotencyKey).toBe('key-1');
    expect([tx.id, tx.walletId, tx.playerId, tx.roundId, tx.gameId, tx.kind]).toEqual([
      'tx-1',
      'w1',
      'p1',
      'r1',
      'g1',
      Kind.Bet,
    ]);
    expect(tx.money.toString()).toBe('25.00');
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.payloadHash).toBe(payloadHash(p));
  });

  it('hash is stable, depends on money, and ignores the idempotency key', () => {
    const a = WagerTransaction.create(props());
    expect(WagerTransaction.create(props()).payloadHash).toBe(a.payloadHash);
    expect(WagerTransaction.create(props({ money: brl('25.01') })).payloadHash).not.toBe(a.payloadHash);
    expect(WagerTransaction.create(props({ idempotencyKey: 'other' })).payloadHash).toBe(a.payloadHash);
  });
});

describe('transitions (7.3)', () => {
  const pendingStates = ['PENDING', 'PENDING_REFERENCE'] as const;
  const terminalStates = ['PROCESSED', 'REJECTED', 'FAILED'] as const;

  const actions: [string, (tx: WagerTransaction) => void, Status][] = [
    ['markProcessed', (tx) => tx.markProcessed('internal-1', at(5)), Status.Processed],
    ['markPendingReference', (tx) => tx.markPendingReference(at(5)), Status.PendingReference],
    ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds), Status.Rejected],
    ['fail', (tx) => tx.fail(FailureCode.ProcessingError), Status.Failed],
  ];

  describe.each(pendingStates)('from %s', (from) => {
    it.each(actions)('%s is allowed', (_name, act, to) => {
      const tx = inState(from);
      act(tx);
      expect(tx.status).toBe(to);
    });
  });

  describe.each(terminalStates)('from %s', (from) => {
    it.each(actions)('%s throws InvalidTransactionStateError', (_name, act, to) => {
      const tx = inState(from);
      const before = snapshot(tx);
      expect(() => act(tx)).toThrow(InvalidTransactionStateError);
      expect(() => act(tx)).toThrow(new RegExp(`${from}.*${to}`));
      expect(snapshot(tx)).toEqual(before);
    });
  });

  it('markProcessed stores the reference id, processedAt, and clears nextAttemptAt', () => {
    const tx = inState('PENDING_REFERENCE');
    expect(tx.nextAttemptAt).toBeDefined();
    tx.markProcessed('internal-1', at(30));
    expect(tx.referenceTransactionId).toBe('internal-1');
    expect(tx.processedAt).toEqual(at(30));
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  it('markProcessed(undefined, at) leaves referenceTransactionId undefined', () => {
    const tx = makeProcessedBet();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toEqual(at(1));
  });

  it('processedAt is set only by markProcessed', () => {
    const rejected = inState('REJECTED');
    const failed = inState('FAILED');
    expect(rejected.processedAt).toBeUndefined();
    expect(failed.processedAt).toBeUndefined();
  });

  it('reject and fail store the code and clear nextAttemptAt', () => {
    const rejected = inState('PENDING_REFERENCE');
    rejected.reject(FailureCode.ReferenceNotFound);
    expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(rejected.nextAttemptAt).toBeUndefined();

    const failed = inState('PENDING_REFERENCE');
    failed.fail(FailureCode.ProcessingError);
    expect(failed.failureCode).toBe(FailureCode.ProcessingError);
    expect(failed.nextAttemptAt).toBeUndefined();
  });

  it('reject(ProcessingError) is a programming error: plain Error, nothing changes', () => {
    const tx = inState('PENDING');
    const before = snapshot(tx);
    expect(() => tx.reject(FailureCode.ProcessingError)).toThrow(Error);
    expect(() => tx.reject(FailureCode.ProcessingError)).not.toThrow(InvalidTransactionStateError);
    expect(snapshot(tx)).toEqual(before);
  });

  it('fail(anything but ProcessingError) is a programming error: plain Error, nothing changes', () => {
    const tx = inState('PENDING');
    const before = snapshot(tx);
    expect(() => tx.fail(FailureCode.InsufficientFunds)).toThrow(Error);
    expect(() => tx.fail(FailureCode.InsufficientFunds)).not.toThrow(InvalidTransactionStateError);
    expect(snapshot(tx)).toEqual(before);
  });

  it('isTerminal is true only for PROCESSED, REJECTED, FAILED', () => {
    expect(pendingStates.map((s) => inState(s).isTerminal())).toEqual([false, false]);
    expect(terminalStates.map((s) => inState(s).isTerminal())).toEqual([true, true, true]);
  });
});

describe('small queries (7.4)', () => {
  it.each([
    [Kind.Bet, true, false, false],
    [Kind.Win, true, false, false],
    [Kind.Loss, false, false, false],
    [Kind.Refund, true, true, true],
    [Kind.Rollback, true, true, true],
    [Kind.Opening, true, false, false],
  ])('%s: affectsBalance=%s requiresReference=%s hasReference=%s', (kind, affects, requires, has) => {
    const tx = make(kind, { money: brl('25.00') });
    expect(tx.affectsBalance()).toBe(affects);
    expect(tx.requiresReference()).toBe(requires);
    expect(tx.hasReference()).toBe(has);
  });

  it('hasReference is true for an optional reference that was supplied', () => {
    expect(make(Kind.Win, { referenceExternalTransactionId: 'ext-ref' }).hasReference()).toBe(true);
    expect(make(Kind.Win).hasReference()).toBe(false);
  });

  it('hasReference does not depend on the reference being resolved', () => {
    const tx = make(Kind.Refund);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.hasReference()).toBe(true);
  });

  it('matchesPayload compares the stored hash', () => {
    const tx = make(Kind.Bet);
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload('0'.repeat(64))).toBe(false);
  });
});

describe('ledgerDirectionFor (7.5)', () => {
  it.each([
    [Kind.Opening, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Credit],
    [Kind.Refund, LedgerDirection.Credit],
    [Kind.Bet, LedgerDirection.Debit],
  ])('%s is %s', (kind, direction) => {
    expect(make(kind).ledgerDirectionFor()).toBe(direction);
  });

  it('LOSS has no ledger movement', () => {
    expect(() => make(Kind.Loss, { money: brl('0.00') }).ledgerDirectionFor()).toThrow(Error);
  });

  it.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])('ROLLBACK of a %s is %s', (refKind, direction) => {
    expect(make(Kind.Rollback).ledgerDirectionFor(make(refKind))).toBe(direction);
  });

  it('ROLLBACK without its reference throws', () => {
    expect(() => make(Kind.Rollback).ledgerDirectionFor()).toThrow(Error);
  });

  it.each([Kind.Loss, Kind.Opening, Kind.Rollback])('ROLLBACK of a %s throws', (refKind) => {
    const ref = make(refKind, refKind === Kind.Loss ? { money: brl('0.00') } : {});
    expect(() => make(Kind.Rollback).ledgerDirectionFor(ref)).toThrow(Error);
  });
});

describe('markPendingReference and retryLimitReached (7.6)', () => {
  it('follows the D3 timeline: 20 s, 60 s, 140 s, then the limit', () => {
    const tx = make(Kind.Refund);
    expect(tx.retryLimitReached()).toBe(false);

    tx.markPendingReference(at(0));
    expect([tx.status, tx.attempts, tx.nextAttemptAt, tx.retryLimitReached()]).toEqual([
      Status.PendingReference,
      0,
      at(20),
      false,
    ]);

    tx.markPendingReference(at(20));
    expect([tx.attempts, tx.nextAttemptAt, tx.retryLimitReached()]).toEqual([1, at(60), false]);

    tx.markPendingReference(at(60));
    expect([tx.attempts, tx.nextAttemptAt, tx.retryLimitReached()]).toEqual([2, at(140), true]);

    expect(() => tx.markPendingReference(at(140))).toThrow('retry limit');
    expect(() => tx.markPendingReference(at(140))).not.toThrow(InvalidTransactionStateError);

    tx.reject(FailureCode.ReferenceNotFound);
    expect([tx.status, tx.attempts, tx.nextAttemptAt, tx.retryLimitReached()]).toEqual([
      Status.Rejected,
      2,
      undefined,
      false,
    ]);
  });

  it('markProcessed after a retry clears nextAttemptAt', () => {
    const tx = make(Kind.Refund);
    tx.markPendingReference(at(0));
    tx.markPendingReference(at(20));
    tx.markProcessed('internal-1', at(60));
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
  });

  it('markPendingReference from a terminal state throws InvalidTransactionStateError', () => {
    const tx = inState('PROCESSED');
    expect(() => tx.markPendingReference(at(5))).toThrow(InvalidTransactionStateError);
  });
});

describe('checkReference (7.7)', () => {
  const allowed: Record<Kind, Kind[]> = {
    [Kind.Refund]: [Kind.Bet],
    [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
    [Kind.Win]: [Kind.Bet],
    [Kind.Loss]: [Kind.Bet],
    [Kind.Bet]: [],
    [Kind.Opening]: [],
  };
  const kinds = Object.values(Kind);

  it('REFUND 25.00 of a BET 25.00 with everything equal is fine', () => {
    expect(make(Kind.Refund).checkReference(make(Kind.Bet))).toBeNull();
  });

  it.each([
    ['providerId', { providerId: 'prov-2' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'r2' }],
    ['currency', { money: usd('25.00') }],
  ] as const)('different %s gives REFERENCE_MISMATCH', (_name, override) => {
    expect(make(Kind.Refund).checkReference(make(Kind.Bet, override))).toBe(FailureCode.ReferenceMismatch);
  });

  describe.each(kinds)('%s against every reference kind', (kind) => {
    it.each(kinds)('%s', (refKind) => {
      const expected = allowed[kind].includes(refKind) ? null : FailureCode.InvalidReferenceKind;
      const tx = make(kind);
      const ref = make(refKind);
      expect(tx.checkReference(ref)).toBe(expected);
    });
  });

  it('REFUND of another amount gives REVERSAL_AMOUNT_MISMATCH', () => {
    expect(make(Kind.Refund, { money: brl('20.00') }).checkReference(make(Kind.Bet))).toBe(
      FailureCode.ReversalAmountMismatch,
    );
  });

  it('ROLLBACK of a WIN with another amount gives REVERSAL_AMOUNT_MISMATCH', () => {
    const win = make(Kind.Win, { money: brl('50.00') });
    expect(make(Kind.Rollback, { money: brl('25.00') }).checkReference(win)).toBe(
      FailureCode.ReversalAmountMismatch,
    );
  });

  it('WIN 50.00 of a BET 25.00 is fine (only reversals must match the amount)', () => {
    expect(make(Kind.Win, { money: brl('50.00') }).checkReference(make(Kind.Bet))).toBeNull();
  });

  it('another round and another amount: REFERENCE_MISMATCH wins', () => {
    const tx = make(Kind.Refund, { money: brl('20.00') });
    expect(tx.checkReference(make(Kind.Bet, { roundId: 'r2' }))).toBe(FailureCode.ReferenceMismatch);
  });

  it('another kind and another amount: INVALID_REFERENCE_KIND wins', () => {
    const tx = make(Kind.Refund, { money: brl('20.00') });
    expect(tx.checkReference(make(Kind.Win))).toBe(FailureCode.InvalidReferenceKind);
  });

  it('does not look at the reference status', () => {
    const rejected = make(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds);
    expect(make(Kind.Refund).checkReference(rejected)).toBeNull();
  });
});

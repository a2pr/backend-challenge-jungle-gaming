import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../../src/wager/backoff.js';
import {
  MAX_REFERENCE_RETRIES,
  PENDING_REFERENCE_BACKOFF,
} from '../../../src/wager/wagerTransaction.js';

const seconds = (ms: number) => ms / 1000;

describe('backoffMs', () => {
  it('pending reference policy (20 s base, 120 s cap) doubles then caps', () => {
    const delays = [0, 1, 2, 3, 6].map((a) => seconds(backoffMs(a, 20000, 120000)));
    expect(delays).toEqual([20, 40, 80, 120, 120]);
  });

  it('outbox policy (5 s base, 300 s cap) doubles then caps', () => {
    const delays = [0, 1, 2, 3, 6].map((a) => seconds(backoffMs(a, 5000, 300000)));
    expect(delays).toEqual([5, 10, 20, 40, 300]);
  });

  it('is exactly the cap when the uncapped value equals it', () => {
    expect(backoffMs(2, 30000, 120000)).toBe(120000);
  });

  it('does not overflow to Infinity for a huge attempt count', () => {
    expect(backoffMs(2000, 1000, 300000)).toBe(300000);
  });

  it.each([
    ['negative attempts', -1, 1000, 5000],
    ['fractional attempts', 1.5, 1000, 5000],
    ['NaN attempts', NaN, 1000, 5000],
    ['fractional base', 1, 1.5, 5000],
    ['fractional cap', 1, 1000, 1.5],
  ])('throws for %s', (_label, attempts, base, cap) => {
    expect(() => backoffMs(attempts, base, cap)).toThrow();
  });
});

describe('pending reference policy constants (D3)', () => {
  const { baseMs, capMs } = PENDING_REFERENCE_BACKOFF;

  it('produce the 20 / 40 / 80 / 120 second schedule', () => {
    const delays = [0, 1, 2, 3].map((a) => seconds(backoffMs(a, baseMs, capMs)));
    expect(delays).toEqual([20, 40, 80, 120]);
  });

  it('allow three retries, and the cap does not bind within them', () => {
    expect(MAX_REFERENCE_RETRIES).toBe(3);
    // retries use attempts 0..MAX-1; uncapped value of the last one is still under the cap
    expect(baseMs * 2 ** (MAX_REFERENCE_RETRIES - 1)).toBeLessThanOrEqual(capMs);
  });

  it('total wait until the final rejection is 140 s after the first miss', () => {
    const total = Array.from({ length: MAX_REFERENCE_RETRIES }, (_, a) =>
      backoffMs(a, baseMs, capMs),
    ).reduce((sum, ms) => sum + ms, 0);
    expect(seconds(total)).toBe(140);
  });
});

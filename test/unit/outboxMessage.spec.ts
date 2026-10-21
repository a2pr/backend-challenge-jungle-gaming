import { describe, expect, it } from 'vitest';
import { OutboxMessage, OUTBOX_BACKOFF } from '../../src/messaging/outboxMessage.js';
import { backoffMs } from '../../src/wager/backoff.js';
import { IntegrationEvent, IntegrationEventProps } from '../../src/events/integrationEvent.js';

class TestEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  constructor(props: IntegrationEventProps<{ n: number }>) {
    super(props);
  }
}

const t0 = new Date('2026-10-21T12:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const event = new TestEvent({
  eventId: 'e1', aggregateId: 'a1', correlationId: 'c1', occurredAt: t0, data: { n: 1 },
});
const fresh = () => OutboxMessage.enqueue({ id: 'e1', event, now: t0 });

describe('OutboxMessage', () => {
  it('enqueue is pending, due now, zero attempts, carries the envelope', () => {
    const m = fresh();
    expect(m.attempts).toBe(0);
    expect(m.publishedAt).toBeNull();
    expect(m.isPending()).toBe(true);
    expect(m.isDue(t0)).toBe(true);
    expect(m.eventType).toBe('TestEvent');
    expect(m.payload).toMatchObject({ eventId: 'e1', aggregateId: 'a1', version: 1 });
  });

  it('markPublished sets publishedAt, ends pending, and throws the second time', () => {
    const m = fresh();
    m.markPublished(at(1));
    expect(m.publishedAt).toEqual(at(1));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(at(1_000_000))).toBe(false);
    expect(() => m.markPublished(at(2))).toThrow();
  });

  it('scheduleRetry bumps attempts and moves nextAttemptAt by the backoff', () => {
    const m = fresh();
    m.scheduleRetry(t0);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).toEqual(at(backoffMs(0, OUTBOX_BACKOFF.baseMs, OUTBOX_BACKOFF.capMs)));
    m.scheduleRetry(at(10_000));
    expect(m.attempts).toBe(2);
    expect(m.nextAttemptAt).toEqual(at(10_000 + backoffMs(1, OUTBOX_BACKOFF.baseMs, OUTBOX_BACKOFF.capMs)));
  });

  it('scheduleRetry on a published message throws', () => {
    const m = fresh();
    m.markPublished(t0);
    expect(() => m.scheduleRetry(t0)).toThrow();
  });

  it('isDue is false before nextAttemptAt and true at it', () => {
    const m = fresh();
    m.scheduleRetry(t0); // due at +5 s
    expect(m.isDue(at(4_999))).toBe(false);
    expect(m.isDue(at(5_000))).toBe(true);
  });
});

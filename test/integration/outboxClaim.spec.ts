import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {MikroORM} from '@mikro-orm/postgresql';
import {createOrm, resetSchema, truncateAll} from '../support/db.js';
import {OutboxRepository} from '../../src/messaging/outbox.repository.js';

let orm: MikroORM;
const repo = new OutboxRepository();
const now = new Date('2026-10-21T12:00:00Z');
const seed = (n: number, over: Record<string, unknown> = {}) => orm.em.getConnection().execute(
  `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
   SELECT gen_random_uuid(), gen_random_uuid(), 'T', '{"a":1}', ?, ?, ? FROM generate_series(1, ?)`,
  [over.occ ?? now, over.next ?? now, over.pub ?? null, n]);
beforeAll(async () => { orm = await createOrm(); await resetSchema(orm); await orm.migrator.up(); });
afterAll(() => orm.close());
beforeEach(() => truncateAll(orm));

describe('claimDue', () => {
  it('maps rows, filters published/future, save round-trips', async () => {
    await seed(2); await seed(1, {pub: now}); await seed(1, {next: new Date(now.getTime() + 1000)});
    await orm.em.fork().transactional(async (em) => {
      const got = await repo.claimDue(em, now, 10);
      expect(got).toHaveLength(2);
      expect(got[0].payload).toEqual({a: 1});
      expect(got[0].occurredAt).toBeInstanceOf(Date);
      got[0].markPublished(now); got[1].scheduleRetry(now);
      for (const m of got) await repo.save(em, m);
    });
    const r = await orm.em.getConnection().execute('SELECT attempts, published_at, next_attempt_at FROM outbox_messages WHERE published_at IS NULL AND attempts = 1');
    expect(r).toHaveLength(1);
    expect(new Date(r[0].next_attempt_at).getTime()).toBe(now.getTime() + 5000);
  });
  it('two open transactions get disjoint rows', async () => {
    await seed(10);
    const ids: string[][] = [];
    const a = orm.em.fork(), b = orm.em.fork();
    await a.begin(); await b.begin();
    ids.push((await repo.claimDue(a, now, 5)).map(m => m.id));
    ids.push((await repo.claimDue(b, now, 5)).map(m => m.id));
    await a.commit(); await b.commit();
    expect(ids[0]).toHaveLength(5); expect(ids[1]).toHaveLength(5);
    expect(new Set([...ids[0], ...ids[1]]).size).toBe(10);
  });
});

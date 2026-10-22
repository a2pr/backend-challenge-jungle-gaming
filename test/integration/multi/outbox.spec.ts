import {describe, expect, it} from 'vitest';
import {count, expectEveryEventPublished, useMultiInstances, waitUntil} from '../../support/multi.js';

const t = useMultiInstances(3);

describe('outbox publishers across 3 instances', () => {
    it('300 due rows claimed by 3 publishers: every event published, none lost', async () => {
        // rows exist before the instances start, so all three publishers meet the same backlog on their first tick
        await t.orm.em.getConnection().execute(
            `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
             SELECT gen_random_uuid(), gen_random_uuid(), 'TestEvent', '{}'::jsonb, now(), now() FROM generate_series(1, 300)`);
        await t.start();

        await waitUntil('all outbox rows published', async () => await count(t.orm, 'SELECT 1 FROM outbox_messages WHERE published_at IS NULL') === 0);

        expect(await count(t.orm, 'SELECT 1 FROM outbox_messages WHERE published_at IS NOT NULL')).toBe(300);
        await expectEveryEventPublished(t.orm, t.queues.eventsQueueUrl);   // distinct eventIds equal the rows; duplicates would be fine
    });
});

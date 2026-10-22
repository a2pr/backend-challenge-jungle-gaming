import {afterAll, describe, expect, it} from 'vitest';
import {createTestQueues} from '../../support/sqs.js';
import {startInstances, type Instances} from '../../support/instances.js';

let instances: Instances | undefined;
afterAll(() => instances?.stop());

describe('startInstances', () => {
    it('starts 3 real processes that answer /health/ready and leaves none behind', async () => {
        instances = await startInstances(3, {queues: await createTestQueues()});
        expect(new Set(instances.map((i) => i.port)).size).toBe(3);
        for (const i of instances) expect((await fetch(`http://localhost:${i.port}/health/ready`)).status).toBe(200);

        // the startup line names the instance: INSTANCE_ID reaches the log (and the pid on every line ties the rest to it)
        for (const i of instances) expect(i.stdout()).toContain(`"instanceId":"${i.id}","port":${i.port}`);

        await instances.stop();
        await expect(fetch(`http://localhost:${instances[0].port}/health/live`)).rejects.toThrow();   // port closed: the process is gone
    });
});

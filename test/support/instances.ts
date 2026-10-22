import {spawn, type ChildProcess} from 'node:child_process';
import {constants} from 'node:os';
import type {createTestQueues} from './sqs.js';

export type TestQueues = Awaited<ReturnType<typeof createTestQueues>>;

export interface Instance {
    id: string;
    port: number;
    stdout(): string;                           // collected output, printed when a test fails
    kill(signal: 'SIGKILL' | 'SIGTERM'): void;
    exited: Promise<number>;                    // shell-style status: 143 after SIGTERM, 137 after SIGKILL (128 + signal number)
}
export interface InstancesOptions { queues?: TestQueues; extraEnv?: Record<string, string> }
export type Instances = Instance[] & { stop(): Promise<void> };

const BASE_PORT = 3101;
let nextPort = BASE_PORT;                        // never reused inside a run, so a replacement cannot meet a dying predecessor on the same port
let nextId = 1;

// Real `bun dist/main.js` processes (process.execPath is bun under `bun --bun vitest`): only separate processes prove there is no hidden shared memory.
// They share what the test process has in env (DATABASE_URL = the test database, AWS_*) and the throwaway queues in `opts.queues`.
export async function startInstances(count = Number(process.env.TESTING_MULTIPLE_INSTANCES ?? 3), opts: InstancesOptions = {}): Promise<Instances> {
    const instances = Array.from({length: count}, () => spawnInstance(nextPort++, nextId++, opts));
    const stop = async () => {
        instances.forEach((i) => i.kill('SIGKILL'));    // no-op for the ones already gone
        await Promise.all(instances.map((i) => i.exited));
    };
    const all = Object.assign(instances, {stop});
    try {
        await Promise.all(instances.map((i) => waitReady(i)));
    } catch (error) {
        await stop();
        throw error;
    }
    return all;
}

function spawnInstance(port: number, n: number, {queues, extraEnv}: InstancesOptions): Instance {
    const id = `instance-${n}`;
    const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
        env: {
            ...process.env,
            PORT: String(port),
            INSTANCE_ID: id,
            WORKERS_ENABLED: 'true',
            DATABASE_POOL_MAX: '10',            // 3 instances x 10 stay far below Postgres max_connections
            ...(queues ? {WAGER_QUEUE_URL: queues.wagerQueueUrl, WAGER_DLQ_URL: queues.wagerDlqUrl, EVENTS_QUEUE_URL: queues.eventsQueueUrl} : {}),
            ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    const exited = new Promise<number>((resolve) => child.once('exit', (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 0))));
    return {
        id, port, exited,
        stdout: () => output,
        kill: (signal) => { child.kill(signal); },
    };
}

// Polls /health/ready with a deadline; on timeout or early exit the error carries the instance output.
async function waitReady(instance: Instance, timeoutMs = 30_000): Promise<void> {
    let exitedEarly = false;
    void instance.exited.then(() => { exitedEarly = true; });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exitedEarly) {
        try {
            if ((await fetch(`http://localhost:${instance.port}/health/ready`)).status === 200) return;
        } catch { /* not listening yet */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${instance.id} ${exitedEarly ? 'exited' : 'not ready after ' + timeoutMs + ' ms'}:\n${instance.stdout()}`);
}

// Prints every instance's output; call it from a failing test or an afterEach that sees a failure.
export const dumpOutput = (instances: Instance[]) =>
    instances.forEach((i) => console.error(`----- ${i.id} (port ${i.port}) -----\n${i.stdout()}`));

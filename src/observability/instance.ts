import { hostname } from 'node:os';

// One name per process: INSTANCE_ID, or the hostname (the container id in Compose). Read once at load, so every log line
// and every metric of a process carries the same value.
export const INSTANCE_ID = process.env.INSTANCE_ID ?? hostname();

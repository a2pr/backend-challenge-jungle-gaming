import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import ensureDatabase from './globalSetup.js';

const newest = (dir: string): number =>
    Math.max(0, ...readdirSync(dir, {recursive: true, withFileTypes: true})
        .filter((e) => e.isFile())
        .map((e) => statSync(join(e.parentPath, e.name)).mtimeMs));

// The children run dist/, which vitest never transforms: a stale build would test old code.
// Skipped when dist/main.js is newer than every file in src/, to keep reruns fast.
export default async function setup() {
    await ensureDatabase();
    const built = existsSync('dist/main.js') ? statSync('dist/main.js').mtimeMs : 0;
    if (built > newest('src')) return;
    const build = spawnSync('node_modules/.bin/nest', ['build'], {stdio: 'inherit'});
    if (build.status !== 0 || !existsSync('dist/main.js')) throw new Error('nest build failed, see the output above');
}

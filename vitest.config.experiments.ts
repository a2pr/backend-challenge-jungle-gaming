import {defineConfig} from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import {loadEnv} from 'vite';

// Experiments are run by hand: bunx vitest run --config ./vitest.config.experiments.ts
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        root: './',
        include: ['test/experiments/**/*.spec.ts'],
        globalSetup: ['test/support/globalSetup.ts'],
        testTimeout: 300_000,
        hookTimeout: 60_000,
    },
});

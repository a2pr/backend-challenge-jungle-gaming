import {defineConfig} from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import {loadEnv} from 'vite';

// Multi-instance specs start real `node dist/main.js` processes, so they need dist/ built (globalSetupMulti does it)
// and are kept out of test:e2e. Run with: bun run test:multi
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        root: './',
        include: ['test/integration/multi/**/*.spec.ts'],
        fileParallelism: false,
        globalSetup: ['test/support/globalSetupMulti.ts'],
        testTimeout: 90_000,
        hookTimeout: 90_000,
        env: {DATABASE_POOL_MAX: '20'},
    },
});

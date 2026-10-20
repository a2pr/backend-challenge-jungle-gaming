import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { loadEnv } from 'vite';
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/e2e/**/*.e2e-spec.ts', 'test/integration/**/*.spec.ts'],
    fileParallelism: false,
    globalSetup: ['test/support/globalSetup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    env: { DATABASE_POOL_MAX: '60' }
  },
});

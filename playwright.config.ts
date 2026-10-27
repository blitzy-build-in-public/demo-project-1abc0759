/**
 * Playwright configuration: the `e2e` browser flows and the `perf` check (SC12), Chromium only.
 *
 * - `npm run test:e2e` builds, then runs `playwright test --project=e2e`. Playwright starts
 *   `node dist/server.js` on port 3100 against the caller's `DATABASE_URL`, which must name a
 *   `_test` database: the global setup refuses any other, applies migrations and truncates the
 *   application tables once.
 * - `npm run test:perf` runs `playwright test --project=perf` with `PERF_BASE_URL` pointing at the
 *   production-mode compose container. That run starts no server and skips the e2e global setup,
 *   because it targets the application database, which is not a `_test` database.
 *
 * Browsers come from `npx playwright install --with-deps chromium` on the Node 20 test host.
 */

import { randomBytes } from 'node:crypto';

import { defineConfig, devices } from '@playwright/test';

const perfBaseUrl = process.env.PERF_BASE_URL;
/** A non-empty `PERF_BASE_URL` marks the performance run against an already running app. */
const isPerfRun = perfBaseUrl !== undefined && perfBaseUrl !== '';

/** Port and origin of the server Playwright starts for the `e2e` project. */
const E2E_PORT = 3100;
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The resolved configuration. Playwright loads its config through a default export only, so this
 * is the one exception to the codebase's no-default-exports convention.
 */
export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The perf spec seeds one user and times pages one after another; parallel workers would skew
  // the measurements. Otherwise Playwright's default (or `--workers`) applies.
  workers: isPerfRun ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  // `tests/perf/perf.spec.ts` writes `test-results/perf.json` here.
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
  // `globalSetup` is a top-level option and cannot be scoped to a project, so it and the web
  // server are left out of the performance run as a whole: that run must never meet the `_test`
  // guard or the truncation, and it measures the container rather than a server started here.
  ...(isPerfRun
    ? {}
    : {
        globalSetup: './tests/e2e/global-setup.ts',
        webServer: {
          // `npm run test:e2e` builds first. The server applies pending migrations before it
          // listens, exactly as in production.
          command: 'node dist/server.js',
          url: `${E2E_BASE_URL}/login`,
          reuseExistingServer: false,
          timeout: 60000,
          stdout: 'pipe',
          stderr: 'pipe',
          // Merged over the caller's environment. The session secret is generated each time the
          // config loads, so no secret is committed. An unset `DATABASE_URL` is passed as empty,
          // which makes the server exit with its configuration error.
          env: {
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            SESSION_SECRET: randomBytes(32).toString('hex'),
            PORT: String(E2E_PORT),
            NODE_ENV: 'test',
          },
        },
      }),
  projects: [
    {
      name: 'e2e',
      testDir: './tests/e2e',
      // Only specs: `global-setup.ts` and `support.ts` in the same directory are not tests.
      testMatch: '**/*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: E2E_BASE_URL,
      },
    },
    {
      name: 'perf',
      testDir: './tests/perf',
      // `seed.ts` is a helper called from the spec's hooks.
      testMatch: 'perf.spec.ts',
      fullyParallel: false,
      // One test seeds 10,000 tasks, then makes a warm-up and five measured loads of each URL.
      timeout: 600_000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: perfBaseUrl,
      },
    },
  ],
});

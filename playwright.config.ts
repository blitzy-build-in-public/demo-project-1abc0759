/**
 * Playwright configuration: the `e2e` browser flows and the `perf` check (SC12), Chromium only.
 *
 * - `npm run test:e2e` builds, then runs `playwright test --project=e2e`. The caller's
 *   `DATABASE_URL` must name a `_test` database: this config refuses any other as it loads,
 *   before Playwright starts `node dist/server.js` on port 3100 (or `E2E_PORT`) against it, and
 *   the global setup checks it again, applies migrations and truncates the application tables
 *   once.
 * - `npm run test:perf` runs `playwright test --project=perf` with `PERF_BASE_URL` pointing at the
 *   production-mode compose container. That run starts no server and skips the e2e global setup,
 *   because it targets the application database, which is not a `_test` database.
 *
 * Browsers come from `npx playwright install --with-deps chromium` on the Node 20 test host.
 */

import { randomBytes } from 'node:crypto';

import { defineConfig, devices } from '@playwright/test';

import { assertTestDatabaseUrl } from './tests/helpers/test-db';

const perfBaseUrl = process.env.PERF_BASE_URL;
/** A non-empty `PERF_BASE_URL` marks the performance run against an already running app. */
const isPerfRun = perfBaseUrl !== undefined && perfBaseUrl !== '';

/**
 * The `e2e` run's `DATABASE_URL`, once the `_test` guard has accepted it; `undefined` exactly when
 * this is the performance run, which targets the application database and never meets the guard.
 *
 * Playwright starts the web server before it runs the global setup, and the server applies pending
 * migrations and purges expired rows in the database it is given. The guard therefore runs here,
 * as the config loads: an unset or refused URL throws the guard's own message, and Playwright
 * aborts before it starts the server, so nothing connects to that database.
 */
const e2eDatabaseUrl = isPerfRun ? undefined : assertTestDatabaseUrl(process.env.DATABASE_URL);

/**
 * Port of the server Playwright starts for the `e2e` project: 3100 unless `E2E_PORT` names
 * another, so that several checkouts on one host can run the end-to-end tests at the same time.
 */
const E2E_PORT = resolveE2ePort(process.env.E2E_PORT);
/** Origin of the server Playwright starts for the `e2e` project. */
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Returns the e2e server port: 3100 when `raw` is unset or empty, otherwise `raw` as an integer
 * from 1 to 65535.
 *
 * @param raw - The `E2E_PORT` environment value.
 * @returns The port number.
 * @throws Error when `raw` is set but is not an integer from 1 to 65535.
 */
function resolveE2ePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 3100;
  }
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error('E2E_PORT must be an integer between 1 and 65535');
  }
  return port;
}

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
  // server are left out of the performance run as a whole, the one run without an
  // `e2eDatabaseUrl`: that run must never meet the `_test` guard or the truncation, and it
  // measures the container rather than a server started here.
  ...(e2eDatabaseUrl === undefined
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
          // config loads, so no secret is committed. `DATABASE_URL` is the caller's URL as the
          // `_test` guard accepted it above.
          env: {
            DATABASE_URL: e2eDatabaseUrl,
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

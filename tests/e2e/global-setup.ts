import type { FullConfig } from '@playwright/test';

import { runMigrations } from '../../src/db/migrate';
import { createLogger } from '../../src/shared/logger';
import { assertTestDatabaseUrl, createTestPool, truncateAll } from '../helpers/test-db';

/**
 * Playwright global setup for the `e2e` project. `playwright.config.ts` wires it only when
 * `PERF_BASE_URL` is unset, so the performance run against the application database never
 * reaches the guard or the truncation.
 *
 * In order, it:
 * 1. refuses to continue unless `DATABASE_URL` names a database whose name ends in `_test`,
 *    before it opens a connection. `playwright.config.ts` applies the same check as it loads,
 *    before the `webServer` starts, so neither the server nor this setup ever connects to a
 *    refused database;
 * 2. applies pending migrations with the server's own `runMigrations`, which is idempotent and
 *    serialised by its advisory lock, so the outcome is the same whether the `webServer` has
 *    already migrated the database or starts migrating it at the same moment;
 * 3. truncates the application tables once, leaving `schema_migrations` intact. Each test then
 *    signs up its own uniquely named user, so tests share no data.
 *
 * The default export is the form Playwright requires for a global setup. No teardown is
 * returned.
 *
 * @param _config - The resolved Playwright configuration; not needed by this setup.
 * @throws The guard's error for a URL that is missing, not `postgres://` or `postgresql://`,
 *   holding a raw space or a malformed percent-escape, or not a `_test` database, or the first
 *   migration or truncation error; Playwright then aborts the run before any test starts.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  const pool = createTestPool(url);
  try {
    await runMigrations(pool, createLogger());
    await truncateAll(pool);
  } finally {
    await pool.end();
  }
}

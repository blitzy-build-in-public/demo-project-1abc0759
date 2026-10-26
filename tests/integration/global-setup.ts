/**
 * Jest `globalSetup` of the `integration` project (plan 0.8.1, 0.9.2). It runs once, in Jest's
 * parent process, before any integration suite.
 *
 * It refuses every `DATABASE_URL` whose database name does not end in `_test`, so the per-test
 * truncation can never reach a development or production database. It then applies the pending
 * migrations with `runMigrations`, the code the server runs before it listens, on a pool built by
 * the application's own `createPool`.
 *
 * It truncates nothing: each suite resets the application tables in its own `beforeEach`, and
 * `schema_migrations` must survive so that later runs find the schema already migrated.
 */

import { assertTestDatabaseUrl } from '../helpers/test-db';
import { createPool } from '../../src/db/pool';
import { runMigrations } from '../../src/db/migrate';
import { createLogger } from '../../src/shared/logger';

/** `name` of the error the data-access layer raises for a database it cannot reach. */
const DATABASE_UNAVAILABLE_ERROR = 'DatabaseUnavailableError';

/**
 * Message for an unreachable database. It never quotes `DATABASE_URL`, which carries the
 * database password.
 */
const UNREACHABLE_MESSAGE =
  'The integration test database is unreachable. Start PostgreSQL (for example with ' +
  '`docker compose up -d db`) and check that DATABASE_URL points at it.';

/**
 * Guards the test database name, then applies every pending migration to that database.
 *
 * A rejection aborts the Jest run before any suite executes. The `migrations applied` line that
 * `runMigrations` logs (with `count` and `versions`) is written to standard output; against an
 * already-migrated database its count is 0. The pool is always ended, so no connection outlives
 * the setup.
 *
 * @returns Resolves once the database is fully migrated and the pool is closed.
 * @throws Error from the `_test` guard when `DATABASE_URL` is unset, unparseable, not a
 *   `postgres://` or `postgresql://` URL, or names a database whose name does not end in `_test`;
 *   no connection is opened in that case.
 * @throws Error with the unreachable-database message, keeping the data-access error as `cause`,
 *   when the database cannot be reached.
 * @throws Any other migration failure, unchanged.
 */
export default async function globalSetup(): Promise<void> {
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  const logger = createLogger();
  const pool = createPool(url, logger);
  try {
    await runMigrations(pool, logger);
  } catch (err) {
    if (err instanceof Error && err.name === DATABASE_UNAVAILABLE_ERROR) {
      throw new Error(UNREACHABLE_MESSAGE, { cause: err });
    }
    throw err;
  } finally {
    await pool.end();
  }
}

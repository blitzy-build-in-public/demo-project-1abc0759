/**
 * `npm run migrate` entry point: applies pending migrations without starting the server.
 *
 * This file is composition-root code that lives in `src/db`. It is one of the two process entry
 * points, with `src/server.ts`, and those two are the only files that read `process.env`; it
 * passes the environment straight to `src/config.ts`. Its import of `../config` is therefore the
 * intended exception to the data-access layer's import rule, and the layer-map test classes this
 * file with the entry points. No other module in `src/db` may import `../config`.
 *
 * Exit status: 0 when every pending migration was applied (or none was pending), 1 when
 * `DATABASE_URL` is invalid or a migration fails. The connection string is never logged, because
 * it carries the database password.
 */

import { ConfigError, loadDatabaseUrl } from '../config';
import { createLogger } from '../shared/logger';
import { runMigrations } from './migrate';
import { createPool } from './pool';

/**
 * Applies every pending migration to the database named by `DATABASE_URL`, then closes the pool.
 *
 * - An invalid `DATABASE_URL` logs the fixed configuration message alone, with no error object,
 *   and sets exit code 1 without opening a connection. `SESSION_SECRET` is not required.
 * - `runMigrations` logs `migrations applied` with `count` and `versions` on success, which sets
 *   exit code 0.
 * - A migration failure, including an unreachable database, logs `migration failed` with the
 *   error and sets exit code 1.
 * - The pool is always ended, so the process exits instead of waiting on idle connections. A
 *   failure to end it is logged as `pool end failed` and can only set exit code 1, never replace
 *   the migration outcome that was already logged.
 *
 * The result is reported through `process.exitCode` rather than `process.exit()`, so the log
 * lines written to stdout are flushed before the process ends.
 *
 * @returns A promise that resolves once the run has finished and the pool is ended. Every
 *   expected failure is logged and resolved; only an error that is not a {@link ConfigError}
 *   while reading the configuration rejects.
 */
export async function main(): Promise<void> {
  const logger = createLogger();

  let databaseUrl: string;
  try {
    databaseUrl = loadDatabaseUrl(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const pool = createPool(databaseUrl, logger);
  try {
    await runMigrations(pool, logger);
    process.exitCode = 0;
  } catch (err) {
    logger.error('migration failed', err);
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (err) {
      logger.error('pool end failed', err);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  // `main` logs and resolves every failure it expects. The first handler reports anything that
  // escaped it; the second covers a failure of that log write itself, so the chain never rejects.
  void main()
    .catch((err: unknown): void => {
      process.exitCode = 1;
      createLogger().error('migration failed', err);
    })
    .catch((): void => {
      process.exitCode = 1;
    });
}

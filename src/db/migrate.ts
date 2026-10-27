/**
 * Migration runner: applies the versioned SQL files in `migrations/` that the database has not
 * yet recorded, in lexical order, each in its own transaction.
 *
 * The schema changes only through these files. The runner keeps its own bookkeeping table,
 * `schema_migrations`, which no migration file creates or alters. Every statement runs on one
 * checked-out client under a session-level advisory lock, so several processes starting at the
 * same moment (replicas, or two test pools) apply each migration exactly once.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool, PoolClient } from 'pg';

import type { Logger } from '../shared/logger';
import { checkOut, query } from './query';

/**
 * Takes the runner's session-level advisory lock, blocking until any other runner releases it.
 * The two-`int4` key form lives in a key space PostgreSQL keeps apart from the single 64-bit
 * keys of the per-email login locks, so the two can never collide.
 */
const LOCK_SQL = 'SELECT pg_advisory_lock(7253, 1)';

/** Releases the lock taken by {@link LOCK_SQL} on the same session. */
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(7253, 1)';

/** Bootstrap of the bookkeeping table; it runs under the lock, so concurrent runners never race. */
const CREATE_BOOKKEEPING_SQL =
  'CREATE TABLE IF NOT EXISTS schema_migrations ' +
  '(version text PRIMARY KEY, applied_at timestamptz NOT NULL)';

const SELECT_APPLIED_SQL = 'SELECT version FROM schema_migrations';

const RECORD_VERSION_SQL = 'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)';

/** `NNNN_<name>.sql`: a four-digit, zero-padded version and a lower-case snake_case name. */
const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

const SQL_EXTENSION = '.sql';

/** Row read from `schema_migrations`. */
interface AppliedVersionRow {
  version: string;
}

/** Names of the migration files in `dir`, in the lexical order they are applied in. */
async function listMigrationFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
}

/**
 * Runs one migration file and records its version, between `BEGIN` and `COMMIT` on `client`.
 * The caller rolls back when this rejects.
 */
async function applyMigration(client: PoolClient, version: string, sql: string): Promise<void> {
  await query(client, 'BEGIN', []);
  // No parameters, so pg uses the simple-query protocol, which accepts the file's several
  // statements and the dollar-quoted PL/pgSQL body in one string.
  await query(client, sql, []);
  // The runner has no Clock: the application time is bookkeeping here, still bound rather than
  // taken from the database's now().
  await query(client, RECORD_VERSION_SQL, [version, new Date()]);
  await query(client, 'COMMIT', []);
}

/** Issues `ROLLBACK` and reports whether it succeeded. Its own failure is never rethrown. */
async function rollBack(client: PoolClient): Promise<boolean> {
  try {
    await query(client, 'ROLLBACK', []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies every pending migration in `dir` and returns the versions it applied.
 *
 * A migration's version is its file name without `.sql`, for example `0001_create_users`.
 * Files that do not match `NNNN_<name>.sql` are ignored, and so are recorded versions that no
 * longer have a file. Once a file has been applied anywhere it is never edited: later schema
 * changes are new, higher-numbered files.
 *
 * Every statement runs on one client checked out of `pool`, because a session-level advisory
 * lock belongs to one database session. The lock is taken before the bookkeeping table is
 * created, so concurrent runners are serialised from their first statement: one applies the
 * pending files and the others then find nothing left to do. Each file is applied with its
 * version record in one transaction, so it is all-or-nothing, and a failure stops the run with
 * the files before it committed.
 *
 * On success the runner logs `migrations applied` with `count` and the comma-joined `versions`,
 * also when nothing was pending. A failure is not logged here; it is rethrown for the caller to
 * log. The lock is always released and the client returned exactly once. When the unlock itself
 * fails, that is logged as `migration unlock failed` and the connection is destroyed instead,
 * which ends its session and so frees the lock. A logger that throws while reporting the unlock
 * failure prevents neither that release nor the run's own outcome: its error is dropped.
 *
 * @param pool - Pool to check the runner's client out of.
 * @param logger - Receives the `migrations applied` and `migration unlock failed` entries.
 * @param dir - Directory holding the migration files. The default is the `migrations` directory
 *   beside this module: `src/db/migrations` under ts-jest, `dist/db/migrations` after the build.
 * @returns The versions applied by this call, in the order they were applied; empty when none
 *   were pending.
 * @throws The first error met: checking out the client, taking the lock, reading the directory
 *   or a file, or running a migration. A database that cannot be reached, whether at checkout or
 *   mid-run, surfaces as `DatabaseUnavailableError`.
 */
export async function runMigrations(
  pool: Pool,
  logger: Logger,
  dir: string = path.join(__dirname, 'migrations'),
): Promise<string[]> {
  // Not `pool.connect()`: an unreachable database must surface as `DatabaseUnavailableError`
  // already at checkout, like every other data-access failure to connect, and the client needs
  // `checkOut`'s `error` listener so a server that ends the session mid-run cannot crash the
  // process.
  const client = await checkOut(pool);
  let locked = false;
  let destroyConnection = false;
  try {
    await query(client, LOCK_SQL, []);
    locked = true;

    await query(client, CREATE_BOOKKEEPING_SQL, []);
    const recorded = await query<AppliedVersionRow>(client, SELECT_APPLIED_SQL, []);
    const alreadyApplied = new Set(recorded.map((row) => row.version));

    const applied: string[] = [];
    for (const fileName of await listMigrationFiles(dir)) {
      const version = fileName.slice(0, -SQL_EXTENSION.length);
      if (alreadyApplied.has(version)) {
        continue;
      }
      const sql = await readFile(path.join(dir, fileName), 'utf8');
      try {
        await applyMigration(client, version, sql);
      } catch (err) {
        // A connection the rollback could not reset may still hold an open transaction, so it
        // must not go back to the pool.
        destroyConnection = !(await rollBack(client));
        throw err;
      }
      applied.push(version);
    }

    logger.info('migrations applied', { count: applied.length, versions: applied.join(',') });
    return applied;
  } finally {
    // The release sits in its own `finally`, so nothing on the unlock path can skip it.
    try {
      if (locked) {
        try {
          await query(client, UNLOCK_SQL, []);
        } catch (err) {
          // Destroying the connection ends its session and so frees the lock. It is decided
          // before the failure is logged, so a failing logger cannot keep the lock held.
          destroyConnection = true;
          try {
            logger.error('migration unlock failed', err);
          } catch {
            // Dropped on purpose: the unlock failure is already handled by destroying the
            // connection, and the run's own outcome (the applied versions, or the migration
            // error already in flight) must stand rather than be replaced by the logger's.
          }
        }
      }
    } finally {
      if (destroyConnection) {
        client.release(true);
      } else {
        client.release();
      }
    }
  }
}

/**
 * Performance-check seed: one real user with 10,000 tasks (plan 0.9.3, success criterion SC12).
 *
 * The user signs up through the running application, so the account, its bcrypt hash and its
 * CSRF flow are genuine. The tasks are then inserted with a single `INSERT … SELECT` over
 * `generate_series`, every value derived deterministically from the series index and from one
 * `now` taken here, so two runs differ only in the owner, the ids and the time shift of `now`.
 *
 * The check runs against the production-mode compose container and its development database, not
 * a `_test` database, so this module never imports the test-database helpers, never truncates,
 * and touches only the rows of the user it creates. It is runner-neutral: it defines no tests and
 * imports no test framework, and `tests/perf/perf.spec.ts` calls it from its hooks.
 *
 * Neither the password, the session cookie nor the database URL (which carries the database
 * password) is ever printed or placed in an error message.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createPool } from '../../src/db/pool';
import { query } from '../../src/db/query';
import { todayUtc } from '../../src/shared/dates';
import type { IsoDate } from '../../src/shared/dates';
import { createLogger } from '../../src/shared/logger';
import type { Logger } from '../../src/shared/logger';
import { HttpClient } from '../helpers/http-client';

/** Number of tasks seeded for the perf user, the load SC12 is sized for. */
export const PERF_TASK_COUNT = 10000;

/** The seeded perf user, as `tests/perf/perf.spec.ts` logs in and asserts with it. */
export interface PerfUser {
  /** The unique sign-up email, `perf-<uuid>@example.test`. */
  readonly email: string;
  /** The generated password; it must never be logged or printed. */
  readonly password: string;
  /** The user's `users.id`. */
  readonly userId: number;
  /**
   * How many of the user's tasks are `To do` with priority `High`: the exact row count expected
   * on `/tasks?status=To%20do&priority=High`.
   */
  readonly filteredCount: number;
  /** Ends the seed's database pool. Only the first call acts; later calls resolve with it. */
  close(): Promise<void>;
}

/**
 * Each seeded user's pool, kept out of {@link PerfUser} so that the exported shape stays as the
 * spec uses it while {@link deletePerfUser} can still reach the database.
 */
const pools = new WeakMap<PerfUser, Pool>();

/** The anonymous sign-up page, which sets the `csrf` nonce cookie and renders `_csrf`. */
const SIGN_UP_PATH = '/signup';

/** Where a successful sign-up redirects (with 303) when no return path is carried. */
const SIGN_UP_SUCCESS_LOCATION = '/login?created=1';

const SELECT_USER_ID_SQL = 'SELECT id FROM users WHERE lower(email) = lower($1)';

const DELETE_USER_BY_EMAIL_SQL = 'DELETE FROM users WHERE lower(email) = lower($1)';

/** Deleting the user cascades to its sessions and tasks; a trigger removes its login attempts. */
const DELETE_USER_BY_ID_SQL = 'DELETE FROM users WHERE id = $1 RETURNING id';

const COUNT_FILTERED_SQL = `SELECT count(*) AS n FROM tasks
WHERE owner_id = $1 AND status = 'To do' AND priority = 'High'`;

/**
 * Inserts the perf tasks in one statement and returns how many rows it inserted.
 *
 * Parameters: `$1` owner id, `$2` now, `$3` today (UTC) as `YYYY-MM-DD`, `$4` the task count.
 * With `i` the series index from 1:
 * - status: 40 % `To do`, 30 % `In progress`, 30 % `Done` (`i % 10`);
 * - priority: an even split of `Low`, `Medium`, `High` (`i % 3`);
 * - due date: NULL for every fifth task, otherwise today − 180 to today + 180;
 * - created_at: up to 364 days and 86,399 s before now, so always on or after UTC day
 *   today − 365, which the 366-day export and completions ranges therefore cover;
 * - completed_at: for `Done` only, 7 % to 99 % of the way from created_at to now, never later,
 *   which keeps `tasks_completed_at_check` and keeps completions out of the future;
 * - updated_at: the later of created_at and completed_at (`GREATEST` skips NULL);
 * - title: 20 to 80 characters;
 * - description: 0 to 1,000 characters, and every tenth one contains a comma, a double quote
 *   and a line break (`chr(10)`), the CSV quoting cases.
 *
 * No value comes from `random()` or the database clock, so the data set is reproducible.
 */
const INSERT_TASKS_SQL = `WITH inserted AS (
  INSERT INTO tasks
    (owner_id, title, description, status, priority, due_date, created_at, updated_at,
     completed_at)
  SELECT
    $1::bigint,
    'Perf task ' || lpad(g.i::text, 5, '0') || ' '
      || left(repeat('abcdefghij', 7), 4 + g.i % 61),
    CASE WHEN g.i % 10 = 0
      THEN left('Note, with "quotes"' || chr(10) || repeat('lorem ipsum ', 84),
                greatest(20, (g.i * 37) % 1001))
      ELSE left(repeat('lorem ipsum ', 84), (g.i * 37) % 1001)
    END,
    CASE WHEN g.i % 10 < 4 THEN 'To do' WHEN g.i % 10 < 7 THEN 'In progress' ELSE 'Done' END,
    (ARRAY['Low', 'Medium', 'High'])[g.i % 3 + 1],
    CASE WHEN g.i % 5 = 0 THEN NULL ELSE $3::date + ((g.i * 7) % 361 - 180) END,
    c.created_at,
    GREATEST(c.created_at, d.completed_at),
    d.completed_at
  FROM generate_series(1, $4::int) AS g(i)
  CROSS JOIN LATERAL (
    SELECT $2::timestamptz - make_interval(days => g.i % 365, secs => (g.i * 7919) % 86400)
      AS created_at
  ) AS c
  CROSS JOIN LATERAL (
    SELECT CASE WHEN g.i % 10 >= 7
      THEN c.created_at + ($2::timestamptz - c.created_at) * ((g.i % 100) / 100.0)::float8
    END AS completed_at
  ) AS d
  RETURNING 1
)
SELECT count(*) AS n FROM inserted`;

/**
 * Returns a password that meets the sign-up policy: 35 ASCII characters (at most 72 bytes), with
 * a letter and a digit guaranteed whatever the random hex turns out to be.
 */
function generatePassword(): string {
  return `Pf${randomBytes(16).toString('hex')}7`;
}

/** Returns the single count a `count(*) AS n` query produced, or throws when there is none. */
function singleCount(rows: readonly { n: number }[], what: string): number {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`perf seed: ${what} returned no row`);
  }
  return row.n;
}

/**
 * Signs a new perf user up through the running application and seeds it with
 * {@link PERF_TASK_COUNT} tasks.
 *
 * A failure at any step deletes the user (if the sign-up created it) and ends the pool before the
 * error is rethrown, so a failed seed leaves no perf user behind.
 *
 * @param baseUrl - Origin of the running application, for example `http://localhost:3000`.
 * @param databaseUrl - Connection string of the database that application uses.
 * @returns The seeded user; pass it to {@link deletePerfUser} when the check is done.
 * @throws Error when the sign-up is not accepted, the user row cannot be found, or the insert does
 *   not store exactly {@link PERF_TASK_COUNT} tasks; any database error unchanged.
 */
export async function seedPerfUser(baseUrl: string, databaseUrl: string): Promise<PerfUser> {
  const email = `perf-${randomUUID()}@example.test`;
  const password = generatePassword();
  const logger = createLogger();
  // The pool is created before the sign-up (it connects only on first use), so the cleanup below
  // also covers a sign-up that created the account but answered unexpectedly.
  const pool = createPool(databaseUrl, logger);

  try {
    const client = new HttpClient(baseUrl);
    const page = await client.get(SIGN_UP_PATH);
    if (page.status !== 200) {
      throw new Error(`perf sign-up page failed: HTTP ${page.status}`);
    }
    // `post` submits the `_csrf` token of the page just received; the jar keeps the `Secure`
    // nonce cookie a production-mode server sets, even over plain HTTP.
    const signUp = await client.post(SIGN_UP_PATH, { email, password });
    if (signUp.status !== 303 || !(signUp.location ?? '').startsWith(SIGN_UP_SUCCESS_LOCATION)) {
      throw new Error(`perf sign-up failed: HTTP ${signUp.status}`);
    }

    const users = await query<{ id: number }>(pool, SELECT_USER_ID_SQL, [email]);
    const user = users[0];
    if (user === undefined) {
      throw new Error(`perf seed: no users row for ${email} after sign-up`);
    }
    const userId = user.id;

    const now = new Date();
    const today: IsoDate = todayUtc(now);
    const inserted = singleCount(
      await query<{ n: number }>(pool, INSERT_TASKS_SQL, [userId, now, today, PERF_TASK_COUNT]),
      'task insert',
    );
    if (inserted !== PERF_TASK_COUNT) {
      throw new Error(`perf seed: inserted ${inserted} tasks, expected ${PERF_TASK_COUNT}`);
    }

    const filteredCount = singleCount(
      await query<{ n: number }>(pool, COUNT_FILTERED_SQL, [userId]),
      'filtered count',
    );
    if (filteredCount <= 0) {
      throw new Error('perf seed: no To do / High tasks were seeded');
    }

    let ending: Promise<void> | null = null;
    const perfUser: PerfUser = {
      email,
      password,
      userId,
      filteredCount,
      close(): Promise<void> {
        ending ??= pool.end();
        return ending;
      },
    };
    pools.set(perfUser, pool);
    return perfUser;
  } catch (err) {
    await discardFailedSeed(pool, email, logger);
    throw err;
  }
}

/**
 * Best-effort cleanup after a failed seed: deletes the user by email (a no-op when the sign-up
 * never created it) and ends the pool. Cleanup failures are logged, never thrown, so the caller
 * rethrows the error that caused the seed to fail.
 */
async function discardFailedSeed(
  pool: Pool,
  email: string,
  logger: Logger,
): Promise<void> {
  try {
    await query(pool, DELETE_USER_BY_EMAIL_SQL, [email]);
  } catch (cleanupErr) {
    logger.error('perf seed cleanup: user delete failed', cleanupErr);
  }
  try {
    await pool.end();
  } catch (cleanupErr) {
    logger.error('perf seed cleanup: pool end failed', cleanupErr);
  }
}

/**
 * Deletes a user created by {@link seedPerfUser}, with its tasks, sessions and login attempts,
 * then ends the seed's pool whatever the outcome.
 *
 * @param user - The value {@link seedPerfUser} returned.
 * @throws Error when `user` did not come from {@link seedPerfUser}, or no user row was deleted;
 *   any database error unchanged.
 */
export async function deletePerfUser(user: PerfUser): Promise<void> {
  const pool = pools.get(user);
  if (pool === undefined) {
    throw new Error('deletePerfUser: this user was not created by seedPerfUser');
  }
  try {
    const deleted = await query<{ id: number }>(pool, DELETE_USER_BY_ID_SQL, [user.userId]);
    if (deleted.length !== 1) {
      throw new Error(`deletePerfUser: perf user ${user.email} was not deleted`);
    }
  } finally {
    await user.close();
  }
}

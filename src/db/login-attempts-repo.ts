/**
 * Failed-login records for the login lockout: 5 failures for one email within 15 minutes refuse
 * further attempts for that email for 15 minutes, a successful login clears the email's failures,
 * and failures older than 24 hours are purged.
 *
 * Every statement is a parameterised constant, and every time is bound from the caller's clock,
 * never from the database's `now()`, so the lockout can be tested with a fake clock.
 */

import { query } from './query';
import type { Queryable } from './query';

/** Row selected by {@link LATEST_FAILURES_SQL}; `timestamptz` arrives as a `Date`. */
interface FailedAtRow {
  failed_at: Date;
}

/** Row selected by {@link PURGE_BEFORE_SQL}; `pool.ts` parses the INT8 `count(*)` as a number. */
interface CountRow {
  count: number;
}

const RECORD_SQL = 'INSERT INTO login_attempts (email, failed_at) VALUES ($1, $2)';

/** Served by `login_attempts_email_failed_idx (email, failed_at DESC)`. */
const LATEST_FAILURES_SQL =
  'SELECT failed_at FROM login_attempts WHERE email = $1 ORDER BY failed_at DESC LIMIT $2';

/** Served by `login_attempts_email_failed_idx`, whose leading column is `email`. */
const CLEAR_SQL = 'DELETE FROM login_attempts WHERE email = $1';

/** Served by `login_attempts_failed_at_idx`; the CTE turns the deleted rows into one count. */
const PURGE_BEFORE_SQL =
  'WITH d AS (DELETE FROM login_attempts WHERE failed_at < $1 RETURNING 1) ' +
  'SELECT count(*) AS count FROM d';

/**
 * Access to `login_attempts`, the per-email record of failed logins.
 *
 * Every `email` argument is the normalised key `lower(trim(email))` that the caller produced with
 * `normalizeEmail`. The repository never normalises, so the key it stores and matches is exactly
 * the key `DataAccess.withLoginLock` serialises on. Failures for emails that have no account are
 * stored the same way as failures for registered ones, so the lockout reveals nothing about which
 * emails are registered.
 */
export interface LoginAttemptsRepo {
  /**
   * Records one failed login.
   *
   * @param email - Normalised email the attempt was made for.
   * @param failedAt - Instant of the failure, from the injected clock.
   */
  record(email: string, failedAt: Date): Promise<void>;

  /**
   * Returns the email's most recent failure times, newest first, as `evaluateLockout` expects.
   *
   * @param email - Normalised email.
   * @param limit - Maximum number of failures to return; a non-negative integer.
   * @returns Up to `limit` failure instants, newest first; empty when none are recorded.
   * @throws RangeError when `limit` is not a non-negative integer.
   */
  latestFailures(email: string, limit: number): Promise<Date[]>;

  /**
   * Deletes every failure recorded for the email. A successful login calls it inside the same
   * locked transaction that creates the session.
   *
   * @param email - Normalised email.
   */
  clear(email: string): Promise<void>;

  /**
   * Deletes every failure recorded strictly before `cutoff`, for all emails.
   *
   * @param cutoff - Instant before which failures are deleted; the caller passes now − 24 hours.
   * @returns How many rows were deleted.
   */
  purgeBefore(cutoff: Date): Promise<number>;
}

/**
 * Creates the login-attempts repository on the pool, or on one checked-out client so that its
 * statements join that client's transaction.
 *
 * @param db - Where the statements run.
 * @returns The repository.
 */
export function createLoginAttemptsRepo(db: Queryable): LoginAttemptsRepo {
  return {
    async record(email: string, failedAt: Date): Promise<void> {
      await query(db, RECORD_SQL, [email, failedAt]);
    },

    async latestFailures(email: string, limit: number): Promise<Date[]> {
      // PostgreSQL rejects a negative LIMIT, and a fractional one fails to bind as bigint, both
      // with driver errors that hide the caller's mistake.
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('limit must be a non-negative integer');
      }
      const rows = await query<FailedAtRow>(db, LATEST_FAILURES_SQL, [email, limit]);
      return rows.map((row) => row.failed_at);
    },

    async clear(email: string): Promise<void> {
      await query(db, CLEAR_SQL, [email]);
    },

    async purgeBefore(cutoff: Date): Promise<number> {
      const rows = await query<CountRow>(db, PURGE_BEFORE_SQL, [cutoff]);
      // count(*) always yields exactly one row; the guard satisfies noUncheckedIndexedAccess.
      return rows[0]?.count ?? 0;
    },
  };
}

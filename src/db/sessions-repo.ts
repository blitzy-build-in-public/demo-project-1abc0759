/**
 * Sessions repository: the server-side session records behind the signed `sid` cookie.
 *
 * A session row is keyed by the SHA-256 of the session token, never the token itself. Every
 * instant is bound from the caller's clock rather than taken from the database's `now()`, so the
 * idle and absolute expiry rules can be driven by a fake clock in tests. The lifetime limits are
 * passed in by the caller from `src/auth/session-policy.ts`, which stays their single source.
 *
 * No function here logs or stringifies an id hash: it is derived from a credential.
 */

import { query } from './query';
import type { Queryable } from './query';
import type { NewSessionRow, SessionLimits, SessionRecord, UserId } from './types';

/** Server-side session storage, run on the pool or on one transaction's client. */
export interface SessionsRepo {
  /**
   * Stores a new session created at login.
   *
   * @param row - The session's id hash, owner and timestamps; `expiresAt` must already equal
   *   `computeExpiresAt(createdAt, lastActiveAt)`.
   */
  insert(row: NewSessionRow): Promise<void>;

  /**
   * Checks that a session is active at `now` and records `now` as activity, in one atomic
   * statement.
   *
   * @param idHash - SHA-256 of the session token.
   * @param now - The request's time, from the caller's clock.
   * @param limits - The absolute and idle limits from `src/auth/session-policy.ts`.
   * @returns The updated session joined to its user's email, or `null` when the token is unknown
   *   or the session has expired. Nothing is changed in the `null` case.
   */
  touchIfActive(idHash: Buffer, now: Date, limits: SessionLimits): Promise<SessionRecord | null>;

  /**
   * Deletes the session only if it has expired by `now`. Unknown tokens and sessions that are
   * still active, for example because another request has just refreshed them, are left alone.
   *
   * @param idHash - SHA-256 of the session token.
   * @param now - The current time, from the caller's clock.
   */
  deleteIfExpired(idHash: Buffer, now: Date): Promise<void>;

  /**
   * Deletes the session whatever its state, as logout does. An unknown id deletes nothing.
   *
   * @param idHash - SHA-256 of the session token.
   */
  delete(idHash: Buffer): Promise<void>;

  /**
   * Deletes every session that has expired by `now`, for the scheduled purge.
   *
   * @param now - The current time, from the caller's clock.
   * @returns The number of sessions deleted.
   */
  deleteExpired(now: Date): Promise<number>;
}

/** A `sessions` row joined to `users.email`, under its SQL column names. */
interface SessionRow {
  id: Buffer;
  user_id: UserId;
  email: string;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
}

/** The single-column result of {@link DELETE_EXPIRED_SQL}; INT8 arrives as a `number`. */
interface CountRow {
  count: number;
}

const INSERT_SQL = `
  INSERT INTO sessions (id, user_id, created_at, last_active_at, expires_at)
  VALUES ($1, $2, $3, $4, $5)`;

// One statement both decides whether the session is active and records the activity:
// - The row lock the UPDATE takes serialises concurrent requests on one session, so no request
//   can act on a check another request's update has already invalidated.
// - GREATEST keeps last_active_at, and with it expires_at, non-decreasing even when a request
//   carrying an earlier `now` commits after a later one.
// - `$2 < expires_at` is the active test. It is equivalent to isSessionActive because expires_at
//   always holds computeExpiresAt(created_at, last_active_at).
// SET expressions read the row's old values, which is why expires_at repeats
// GREATEST(s.last_active_at, $2) instead of referring to the new last_active_at.
const TOUCH_IF_ACTIVE_SQL = `
  UPDATE sessions AS s
     SET last_active_at = GREATEST(s.last_active_at, $2::timestamptz),
         expires_at = LEAST(
           s.created_at + ($3::double precision * interval '1 millisecond'),
           GREATEST(s.last_active_at, $2::timestamptz)
             + ($4::double precision * interval '1 millisecond'))
    FROM users AS u
   WHERE s.id = $1
     AND $2::timestamptz < s.expires_at
     AND u.id = s.user_id
  RETURNING s.id, s.user_id, u.email, s.created_at, s.last_active_at, s.expires_at`;

const DELETE_IF_EXPIRED_SQL = `
  DELETE FROM sessions
   WHERE id = $1
     AND expires_at <= $2`;

const DELETE_SQL = `
  DELETE FROM sessions
   WHERE id = $1`;

// Counting through a CTE keeps the result a row, so the rows-only query helper can return it.
// sessions_expires_at_idx serves the range predicate.
const DELETE_EXPIRED_SQL = `
  WITH d AS (
    DELETE FROM sessions
     WHERE expires_at <= $1
    RETURNING 1
  )
  SELECT count(*) AS count FROM d`;

/** Maps a joined session row to its record. */
function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    idHash: row.id,
    userId: row.user_id,
    userEmail: row.email,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Creates the sessions repository on a pool or on one transaction's client.
 *
 * @param db - Where every statement runs: the pool, or the client of a transaction such as the
 *   locked login transaction that inserts the new session.
 * @returns The repository; it holds no state beyond `db`.
 */
export function createSessionsRepo(db: Queryable): SessionsRepo {
  return {
    async insert(row: NewSessionRow): Promise<void> {
      await query(db, INSERT_SQL, [
        row.idHash,
        row.userId,
        row.createdAt,
        row.lastActiveAt,
        row.expiresAt,
      ]);
    },

    async touchIfActive(
      idHash: Buffer,
      now: Date,
      limits: SessionLimits,
    ): Promise<SessionRecord | null> {
      const rows = await query<SessionRow>(db, TOUCH_IF_ACTIVE_SQL, [
        idHash,
        now,
        limits.absoluteMs,
        limits.idleMs,
      ]);
      const row = rows[0];
      return row === undefined ? null : toSessionRecord(row);
    },

    async deleteIfExpired(idHash: Buffer, now: Date): Promise<void> {
      await query(db, DELETE_IF_EXPIRED_SQL, [idHash, now]);
    },

    async delete(idHash: Buffer): Promise<void> {
      await query(db, DELETE_SQL, [idHash]);
    },

    async deleteExpired(now: Date): Promise<number> {
      const rows = await query<CountRow>(db, DELETE_EXPIRED_SQL, [now]);
      return rows[0]?.count ?? 0;
    },
  };
}

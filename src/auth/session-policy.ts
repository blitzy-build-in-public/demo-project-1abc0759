/**
 * Session expiry rule: a session ends 8 hours after it was created or 30 minutes after its last
 * activity, whichever comes first.
 *
 * This module is the single source of both limits. The auth service passes them to
 * `SessionsRepo.touchIfActive` as `{ absoluteMs, idleMs }`, so the SQL never hard-codes a duration.
 * Every function is pure and takes the current time as a parameter.
 */

/** Maximum total age of a session: 8 hours, in milliseconds. */
export const SESSION_ABSOLUTE_MS = 28_800_000;

/** Maximum time a session may go without activity: 30 minutes, in milliseconds. */
export const SESSION_IDLE_MS = 1_800_000;

/**
 * Reports whether a session is still active at `now`.
 *
 * A session is active only while its age (`now − createdAt`) is under {@link SESSION_ABSOLUTE_MS}
 * and its idle time (`now − lastActiveAt`) is under {@link SESSION_IDLE_MS}. Both bounds are
 * strict: at exactly 8 hours of age or exactly 30 minutes idle the session is expired.
 *
 * "Active" is equivalent to `now < computeExpiresAt(createdAt, lastActiveAt)`, the invariant that
 * `sessions.expires_at` holds.
 *
 * @param s - The session's creation time and last activity time.
 * @param now - The current time, supplied by the caller's clock.
 * @returns `true` while the session is within both limits, `false` once either is reached.
 */
export function isSessionActive(s: { createdAt: Date; lastActiveAt: Date }, now: Date): boolean {
  const at = now.getTime();
  return (
    at - s.createdAt.getTime() < SESSION_ABSOLUTE_MS &&
    at - s.lastActiveAt.getTime() < SESSION_IDLE_MS
  );
}

/**
 * Computes the instant a session expires: the earlier of `createdAt + 8 hours` and
 * `lastActiveAt + 30 minutes`.
 *
 * The session is active exactly while `now` is before the returned instant, so this value is what
 * `sessions.expires_at` stores. It never exceeds `createdAt + 8 hours`, which the `sessions`
 * table's check `expires_at <= created_at + interval '8 hours'` (migration `0002`) also enforces.
 *
 * @param createdAt - When the session was created.
 * @param lastActiveAt - When the session last saw activity.
 * @returns A new `Date`; neither input is modified.
 */
export function computeExpiresAt(createdAt: Date, lastActiveAt: Date): Date {
  return new Date(
    Math.min(createdAt.getTime() + SESSION_ABSOLUTE_MS, lastActiveAt.getTime() + SESSION_IDLE_MS),
  );
}

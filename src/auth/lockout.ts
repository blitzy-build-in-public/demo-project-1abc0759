/**
 * Number of failed login attempts for one email that triggers the refusal.
 */
export const LOCKOUT_THRESHOLD = 5;

/**
 * Maximum span, in milliseconds, between the fifth-newest and the newest failure for them to count
 * as one burst (15 minutes, inclusive).
 */
export const LOCKOUT_WINDOW_MS = 900_000;

/**
 * Length of the refusal, in milliseconds, measured from the newest failure (15 minutes).
 */
export const LOCKOUT_DURATION_MS = 900_000;

/**
 * Outcome of {@link evaluateLockout}.
 */
export interface LockoutDecision {
  /** Whether further login attempts for the email must be refused. */
  locked: boolean;
  /** The instant the refusal lifts when `locked` is true, otherwise `null`. */
  until: Date | null;
}

/**
 * Decides whether login attempts for one email are currently refused.
 *
 * The email is locked exactly when all of the following hold:
 * - at least {@link LOCKOUT_THRESHOLD} failures are supplied;
 * - the newest failure is less than {@link LOCKOUT_DURATION_MS} old at `now`, so at exactly
 *   newest + 15 minutes the lock has lifted;
 * - the newest and the fifth-newest failures are no more than {@link LOCKOUT_WINDOW_MS} apart.
 *
 * Only the newest and the fifth-newest entries are read; older entries are ignored.
 *
 * The caller relies on these readings:
 * - Refused attempts are never recorded, so the newest failure is the one that reached the
 *   threshold and retrying during the refusal cannot extend it.
 * - The refusal starts at the fifth failure and ends 15 minutes after it.
 * - The caller evaluates before checking credentials, so the fifth failure itself still gets
 *   "Email or password is incorrect." and the sixth attempt is the first one refused.
 * - The rule never needs more than the last 30 minutes of history: the newest failure is under
 *   15 minutes old and the fifth-newest at most 15 minutes older than it.
 *
 * @param failuresNewestFirst - The email's failure times, ordered newest first. At least the
 *   newest {@link LOCKOUT_THRESHOLD} must be supplied for a lock to be possible.
 * @param now - The current time from the injected clock.
 * @returns `{ locked: true, until }` with `until` = newest failure + {@link LOCKOUT_DURATION_MS},
 *   or `{ locked: false, until: null }`.
 */
export function evaluateLockout(failuresNewestFirst: readonly Date[], now: Date): LockoutDecision {
  const newest = failuresNewestFirst[0];
  const fifthNewest = failuresNewestFirst[LOCKOUT_THRESHOLD - 1];
  if (newest === undefined || fifthNewest === undefined) {
    return { locked: false, until: null };
  }

  const newestAt = newest.getTime();
  const withinRefusal = now.getTime() - newestAt < LOCKOUT_DURATION_MS;
  const withinWindow = newestAt - fifthNewest.getTime() <= LOCKOUT_WINDOW_MS;
  if (!withinRefusal || !withinWindow) {
    return { locked: false, until: null };
  }

  return { locked: true, until: new Date(newestAt + LOCKOUT_DURATION_MS) };
}

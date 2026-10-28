/**
 * Source of the current instant for every time-dependent rule.
 *
 * Services and middleware receive a `Clock` through their `deps` and call `now()` instead of
 * constructing dates themselves, so session expiry, lockout, overdue and default-range behaviour
 * can be driven by a fake clock in tests. Pure rules never hold a clock: they take `now` (or
 * `today`) as an argument.
 */
export interface Clock {
  /** Returns the current instant as a new `Date`. */
  now(): Date;
}

/**
 * The production clock, backed by the system time. `src/server.ts` passes it to the services and
 * the application factory.
 *
 * Each call returns a fresh `Date`, so a caller that mutates its result cannot affect another
 * caller.
 */
export const systemClock: Clock = {
  now: (): Date => new Date(),
};

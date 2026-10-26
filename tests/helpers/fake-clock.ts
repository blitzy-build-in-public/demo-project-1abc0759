import type { Clock } from '../../src/shared/clock';

/** Default start instant of a new {@link FakeClock}, as an ISO 8601 UTC timestamp. */
export const FAKE_CLOCK_START = '2026-10-21T09:00:00.000Z';

/**
 * A `Clock` whose time moves only when a test sets or advances it, so session expiry, lockout,
 * overdue and default-range rules can be exercised without waiting. It never reads real time.
 *
 * The instant is held as epoch milliseconds, never as a shared `Date`: `now()` returns a new
 * object on every call, and `set()` copies its argument, so no caller can move the clock by
 * mutating a `Date`.
 */
export class FakeClock implements Clock {
  /** Current instant in epoch milliseconds; always a valid `Date` time value. */
  private current: number;

  /**
   * @param start - Initial instant, as a `Date` or a string `new Date()` accepts. Defaults to
   *   {@link FAKE_CLOCK_START}.
   * @throws Error when `start` is not a valid date.
   */
  constructor(start: Date | string = FAKE_CLOCK_START) {
    this.current = this.toEpochMs(start);
  }

  /** Returns the current instant as a new `Date`, which the caller may mutate freely. */
  now(): Date {
    return new Date(this.current);
  }

  /**
   * Moves the clock to `at`, forwards or backwards.
   *
   * @param at - Target instant, as a `Date` or a string `new Date()` accepts. Its value is copied.
   * @throws Error when `at` is not a valid date.
   */
  set(at: Date | string): void {
    this.current = this.toEpochMs(at);
  }

  /**
   * Moves the clock by `ms` milliseconds. Negative values move it backwards, which the
   * out-of-order activity tests rely on.
   *
   * @param ms - Milliseconds to add to the current instant.
   * @throws Error when `ms` is not finite, or when the result falls outside the range a `Date`
   *   can represent.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new Error('FakeClock.advance: ms must be a finite number');
    }
    const next = new Date(this.current + ms).getTime();
    // Past ±8.64e15 ms a Date is invalid; refusing here keeps every later now() a valid Date.
    if (Number.isNaN(next)) {
      throw new Error('FakeClock.advance: result is outside the Date range');
    }
    this.current = next;
  }

  /** Reads `at` as epoch milliseconds, rejecting values that are not valid dates. */
  private toEpochMs(at: Date | string): number {
    const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
    if (Number.isNaN(ms)) {
      throw new Error('FakeClock.set: invalid date');
    }
    return ms;
  }
}

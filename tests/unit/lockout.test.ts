/**
 * Unit tests of the login lockout rule `evaluateLockout` (pure function, no database, no clock).
 *
 * Covers the "Lockout rules" test item and the unit level of success criterion 2: the 4, 5 and 6
 * failure counts, the window span and the refusal expiry. Four failures are not locked. Five
 * within 15 minutes are locked until the fifth plus 15 minutes. Five spanning more than 15
 * minutes are not locked. The lock lifts at exactly the fifth plus 15 minutes.
 *
 * Every instant is an explicit offset from the newest failure `T`, and every failure list is
 * frozen, so an implementation that sorts or otherwise mutates its input throws.
 */

import {
  evaluateLockout,
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
} from '../../src/auth/lockout';
import type { LockoutDecision } from '../../src/auth/lockout';

/** The newest failure in every fixture. */
const T = new Date('2026-10-21T09:00:00.000Z');

/** One minute in milliseconds. */
const MIN = 60_000;

/** The instant `offsetMs` milliseconds after `T`, or before it when negative. */
function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

/** A frozen newest-first failure list holding one failure per offset from `T`. */
function failures(...offsetsMs: number[]): readonly Date[] {
  return Object.freeze(offsetsMs.map((offsetMs) => at(offsetMs)));
}

/** The decision for an email whose attempts are not refused. */
const UNLOCKED: LockoutDecision = { locked: false, until: null };

/** The decision for an email refused until `offsetMs` after `T`. */
function lockedUntil(offsetMs: number): LockoutDecision {
  return { locked: true, until: at(offsetMs) };
}

/** Five failures one minute apart, the newest at `T`: the threshold burst. */
const BURST = failures(0, -MIN, -2 * MIN, -3 * MIN, -4 * MIN);

/** One `evaluateLockout` call and the decision it must return. */
interface LockoutCase {
  name: string;
  history: readonly Date[];
  now: Date;
  expected: LockoutDecision;
}

describe('lockout constants', () => {
  test('lock after 5 failures within 15 minutes, for 15 minutes', () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_WINDOW_MS).toBe(900_000);
    expect(LOCKOUT_DURATION_MS).toBe(900_000);
  });
});

describe('evaluateLockout', () => {
  describe('failure counts', () => {
    test.each<LockoutCase>([
      {
        name: 'no failures is not locked',
        history: failures(),
        now: at(MIN),
        expected: UNLOCKED,
      },
      {
        name: 'four failures within three minutes is not locked',
        history: failures(0, -MIN, -2 * MIN, -3 * MIN),
        now: at(MIN),
        expected: UNLOCKED,
      },
      {
        name: 'five failures within four minutes is locked until the newest plus 15 minutes',
        history: BURST,
        now: at(MIN),
        expected: lockedUntil(15 * MIN),
      },
      {
        name: 'six failures whose oldest is two hours old is locked by the newest five',
        history: failures(0, -MIN, -2 * MIN, -3 * MIN, -4 * MIN, -120 * MIN),
        now: at(MIN),
        expected: lockedUntil(15 * MIN),
      },
      {
        name: 'six failures whose fifth-newest is 20 minutes older than the newest is not locked',
        history: failures(0, -MIN, -2 * MIN, -3 * MIN, -20 * MIN, -21 * MIN),
        now: at(MIN),
        expected: UNLOCKED,
      },
    ])('$name', ({ history, now, expected }) => {
      expect(evaluateLockout(history, now)).toStrictEqual(expected);
    });

    test('the refusal ends exactly 900,000 ms after the newest failure', () => {
      const decision = evaluateLockout(BURST, at(MIN));

      expect(decision.locked).toBe(true);
      expect(decision.until?.getTime()).toBe(T.getTime() + 900_000);
    });
  });

  describe('window span between the newest and the fifth-newest failure', () => {
    test.each<LockoutCase>([
      {
        name: 'exactly 15 minutes apart is locked',
        history: failures(0, -MIN, -2 * MIN, -3 * MIN, -15 * MIN),
        now: at(MIN),
        expected: lockedUntil(15 * MIN),
      },
      {
        name: '15 minutes and 1 ms apart is not locked',
        history: failures(0, -MIN, -2 * MIN, -3 * MIN, -15 * MIN - 1),
        now: at(MIN),
        expected: UNLOCKED,
      },
    ])('$name', ({ history, now, expected }) => {
      expect(evaluateLockout(history, now)).toStrictEqual(expected);
    });
  });

  describe('refusal expiry after five failures', () => {
    test.each<LockoutCase>([
      {
        name: 'at the instant of the fifth failure the next attempt is refused',
        history: BURST,
        now: at(0),
        expected: lockedUntil(15 * MIN),
      },
      {
        name: '1 ms before the fifth failure plus 15 minutes is still locked',
        history: BURST,
        now: at(15 * MIN - 1),
        expected: lockedUntil(15 * MIN),
      },
      {
        name: 'exactly the fifth failure plus 15 minutes is no longer locked',
        history: BURST,
        now: at(15 * MIN),
        expected: UNLOCKED,
      },
    ])('$name', ({ history, now, expected }) => {
      expect(evaluateLockout(history, now)).toStrictEqual(expected);
    });
  });
});

/**
 * Unit tests of the session expiry rule in `src/auth/session-policy.ts` (pure functions, no
 * database, no real clock).
 *
 * A session is active only while it is under 8 hours old and under 30 minutes idle. Both bounds
 * are strict, so a session expires at exactly 30:00 idle and at exactly 8:00:00 of age, however
 * recent its last activity. `computeExpiresAt` returns the earlier of the two limits, the instant
 * `sessions.expires_at` stores, and "active" holds exactly while `now` is before it.
 */

import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  computeExpiresAt,
  isSessionActive,
} from '../../src/auth/session-policy';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Creation time of every session under test. */
const T0 = new Date('2026-10-21T09:00:00.000Z');

/** The instant `ms` milliseconds after {@link T0}, the session's age at that instant. */
function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** The instant `ms` milliseconds after `base`. */
function offset(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

/** A session created at {@link T0}, last active at `lastActiveAt`, checked at `now`. */
interface ActiveCase {
  name: string;
  lastActiveAt: Date;
  now: Date;
  active: boolean;
}

/** A session created at {@link T0}, last active at `lastActiveAt`, and its expected expiry. */
interface ExpiryCase {
  name: string;
  lastActiveAt: Date;
  expiresAt: Date;
}

/** One sampled instant for a session in {@link EXPIRY_CASES}. */
interface EquivalenceCase extends ExpiryCase {
  now: Date;
  active: boolean;
}

/** Sessions limited by each rule in turn, with the expiry `computeExpiresAt` must return. */
const EXPIRY_CASES: readonly ExpiryCase[] = [
  {
    name: 'an idle-limited session (last active at 1:00:00 of age)',
    lastActiveAt: at(1 * HOUR),
    expiresAt: at(1 * HOUR + 30 * MIN),
  },
  {
    name: 'an absolute-limited session (last active at 7:45:00 of age)',
    lastActiveAt: at(7 * HOUR + 45 * MIN),
    expiresAt: at(8 * HOUR),
  },
  {
    name: 'a session whose limits coincide (last active at 7:30:00 of age)',
    lastActiveAt: at(7 * HOUR + 30 * MIN),
    expiresAt: at(8 * HOUR),
  },
  {
    name: 'a new session (no activity since creation)',
    lastActiveAt: T0,
    expiresAt: at(30 * MIN),
  },
];

describe('session limits', () => {
  test('are 8 hours absolute and 30 minutes idle, in milliseconds', () => {
    expect(SESSION_ABSOLUTE_MS).toBe(28800000);
    expect(SESSION_IDLE_MS).toBe(1800000);
  });
});

describe('isSessionActive', () => {
  // The absolute cases keep the last activity within the idle limit, so only the session's age
  // can decide them.
  test.each<ActiveCase>([
    {
      name: '29:59 idle',
      lastActiveAt: at(1 * HOUR),
      now: at(1 * HOUR + 29 * MIN + 59 * SEC),
      active: true,
    },
    {
      name: '1 ms before 30:00 idle',
      lastActiveAt: at(1 * HOUR),
      now: at(1 * HOUR + 30 * MIN - 1),
      active: true,
    },
    {
      name: 'exactly 30:00 idle',
      lastActiveAt: at(1 * HOUR),
      now: at(1 * HOUR + 30 * MIN),
      active: false,
    },
    {
      name: '1 ms after 30:00 idle',
      lastActiveAt: at(1 * HOUR),
      now: at(1 * HOUR + 30 * MIN + 1),
      active: false,
    },
    {
      name: '7:59:59 of age, active one second earlier',
      lastActiveAt: at(7 * HOUR + 59 * MIN + 58 * SEC),
      now: at(7 * HOUR + 59 * MIN + 59 * SEC),
      active: true,
    },
    {
      name: '1 ms before 8:00:00 of age, active one second earlier',
      lastActiveAt: at(7 * HOUR + 59 * MIN + 59 * SEC - 1),
      now: at(8 * HOUR - 1),
      active: true,
    },
    {
      name: 'exactly 8:00:00 of age, active one second earlier',
      lastActiveAt: at(7 * HOUR + 59 * MIN + 59 * SEC),
      now: at(8 * HOUR),
      active: false,
    },
    {
      name: '1 ms after 8:00:00 of age, active one second earlier',
      lastActiveAt: at(7 * HOUR + 59 * MIN + 59 * SEC),
      now: at(8 * HOUR + 1),
      active: false,
    },
  ])('returns $active at $name', ({ lastActiveAt, now, active }) => {
    expect(isSessionActive({ createdAt: T0, lastActiveAt }, now)).toBe(active);
  });
});

describe('computeExpiresAt', () => {
  test.each<ExpiryCase>(EXPIRY_CASES)(
    'returns the earlier limit for $name',
    ({ lastActiveAt, expiresAt }) => {
      expect(computeExpiresAt(T0, lastActiveAt)).toEqual(expiresAt);
    },
  );

  test('returns a new Date and leaves both inputs unchanged', () => {
    const createdAt = at(0);
    const lastActiveAt = at(1 * HOUR);

    const expiresAt = computeExpiresAt(createdAt, lastActiveAt);

    expect(createdAt.getTime()).toBe(T0.getTime());
    expect(lastActiveAt.getTime()).toBe(T0.getTime() + 1 * HOUR);
    expect(expiresAt).not.toBe(createdAt);
    expect(expiresAt).not.toBe(lastActiveAt);
  });
});

describe('isSessionActive and computeExpiresAt', () => {
  const cases: EquivalenceCase[] = EXPIRY_CASES.flatMap((session) =>
    [
      { label: '1 ms before expiry', now: offset(session.expiresAt, -1), active: true },
      { label: 'at expiry', now: session.expiresAt, active: false },
      { label: '1 ms after expiry', now: offset(session.expiresAt, 1), active: false },
      { label: 'at its last activity', now: session.lastActiveAt, active: true },
      { label: 'at 9:00:00 of age', now: at(9 * HOUR), active: false },
    ].map(({ label, now, active }) => ({
      ...session,
      name: `${session.name}, ${label}`,
      now,
      active,
    })),
  );

  test.each<EquivalenceCase>(cases)(
    'agree that a session is active exactly before its expiry: $name',
    ({ lastActiveAt, now, active }) => {
      const session = { createdAt: T0, lastActiveAt };
      const beforeExpiry =
        now.getTime() < computeExpiresAt(session.createdAt, session.lastActiveAt).getTime();

      expect(isSessionActive(session, now)).toBe(beforeExpiry);
      expect(beforeExpiry).toBe(active);
    },
  );
});

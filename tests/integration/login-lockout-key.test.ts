/**
 * Integration tests for the login lockout key against real PostgreSQL 16: every spelling of an
 * email that could reach an account is counted and refused under one lockout key.
 *
 * JavaScript lower-cases 'İ' (U+0130) to 'i' plus U+0307, while PostgreSQL's `lower()` gives a
 * plain 'i'. A login that locked on the first and looked the account up with the second let
 * spellings such as 'vİctim@example.com' reach victim@example.com under a fresh lockout key, and
 * log in while that email was locked. These cases drive the real auth service over the real
 * data-access layer, with bcrypt at cost 12 and a `FakeClock`, so each costs a few comparisons.
 */

import type { Pool } from 'pg';

import { createAuthService } from '../../src/auth/auth-service';
import type { AuthService } from '../../src/auth/auth-service';
import { LOCKOUT_THRESHOLD } from '../../src/auth/lockout';
import { normalizeEmail } from '../../src/auth/password-policy';
import { createDataAccess } from '../../src/db/data-access';

import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import { countRows, createTestPool, loginAttemptRows, sql, truncateAll } from '../helpers/test-db';

/** The registered account's email, which is also its lockout key. */
const CANONICAL_EMAIL = 'victim@example.com';

/** The registered account's password; it meets the sign-up policy. */
const PASSWORD = 'VictimPassw0rd';

/** A password that meets the policy but is not the account's. */
const WRONG_PASSWORD = 'WrongPassw0rd';

/** Gap between consecutive attempts, well inside the 15-minute lockout window. */
const ATTEMPT_GAP_MS = 1_000;

/**
 * Spellings of {@link CANONICAL_EMAIL} with U+0130 in place of 'i'. PostgreSQL's `lower()` folds
 * each to the canonical email, while `normalizeEmail` gives a different, non-ASCII key.
 */
const U0130_VARIANTS: readonly string[] = [
  'v\u0130ctim@example.com',
  'vict\u0130m@example.com',
  'v\u0130ct\u0130m@example.com',
  'V\u0130CT\u0130M@EXAMPLE.COM',
];

/** A row holding the result of PostgreSQL's `lower()`. */
interface LoweredRow {
  lowered: string;
}

describe('login lockout key', () => {
  let pool: Pool;
  let clock: FakeClock;
  let auth: AuthService;

  beforeAll(() => {
    pool = createTestPool();
    clock = new FakeClock();
    auth = createAuthService({ dal: createDataAccess(pool), clock });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    clock.set(FAKE_CLOCK_START);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Creates the victim account through the service, so its hash is a real cost-12 one. */
  async function signUpVictim(): Promise<void> {
    await expect(auth.signUp({ email: CANONICAL_EMAIL, password: PASSWORD })).resolves.toEqual({
      ok: true,
    });
  }

  /** Fails one login for `email` with the wrong password, a second after the previous attempt. */
  async function failLogin(email: string): Promise<void> {
    clock.advance(ATTEMPT_GAP_MS);
    await expect(auth.logIn({ email, password: WRONG_PASSWORD })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  }

  it.each(U0130_VARIANTS)(
    'PostgreSQL lower() folds %j to the canonical email, but normalizeEmail does not',
    async (variant) => {
      const rows = await sql<LoweredRow>(pool, 'SELECT lower($1::text) AS lowered', [variant]);
      expect(rows).toEqual([{ lowered: CANONICAL_EMAIL }]);
      expect(normalizeEmail(variant)).not.toBe(CANONICAL_EMAIL);
    },
  );

  it.each(U0130_VARIANTS)(
    'refuses %j with the correct password while the canonical email is locked',
    async (variant) => {
      await signUpVictim();
      for (let attempt = 0; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
        await failLogin(CANONICAL_EMAIL);
      }
      const canonicalRows = await loginAttemptRows(pool, CANONICAL_EMAIL);
      expect(canonicalRows).toHaveLength(LOCKOUT_THRESHOLD);

      clock.advance(ATTEMPT_GAP_MS);
      const result = await auth.logIn({ email: variant, password: PASSWORD });
      expect(result.ok).toBe(false);
      expect(await countRows(pool, 'sessions')).toBe(0);

      clock.advance(ATTEMPT_GAP_MS);
      await expect(auth.logIn({ email: CANONICAL_EMAIL, password: PASSWORD })).resolves.toEqual({
        ok: false,
        reason: 'locked',
      });
      expect(await countRows(pool, 'sessions')).toBe(0);
      expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual(canonicalRows);
    },
  );

  it.each(U0130_VARIANTS)(
    'treats %j with the correct password as an unknown email under its own key',
    async (variant) => {
      await signUpVictim();
      await failLogin(CANONICAL_EMAIL);
      const canonicalRows = await loginAttemptRows(pool, CANONICAL_EMAIL);
      expect(canonicalRows).toHaveLength(1);

      clock.advance(ATTEMPT_GAP_MS);
      await expect(auth.logIn({ email: variant, password: PASSWORD })).resolves.toEqual({
        ok: false,
        reason: 'invalid',
      });

      const variantRows = await loginAttemptRows(pool, normalizeEmail(variant));
      expect(variantRows).toHaveLength(1);
      expect(variantRows[0]?.failedAt).toEqual(clock.now());
      expect(await countRows(pool, 'login_attempts')).toBe(2);
      expect(await countRows(pool, 'sessions')).toBe(0);
      expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual(canonicalRows);
    },
  );

  it('logs in with an ASCII case variant and clears the canonical failures', async () => {
    await signUpVictim();
    await failLogin(CANONICAL_EMAIL);
    await failLogin('Victim@Example.com');
    expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toHaveLength(2);

    clock.advance(ATTEMPT_GAP_MS);
    const result = await auth.logIn({ email: '  VICTIM@Example.COM  ', password: PASSWORD });
    expect(result).toMatchObject({ ok: true, user: { email: CANONICAL_EMAIL } });
    expect(await countRows(pool, 'sessions')).toBe(1);
    expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual([]);
    expect(await countRows(pool, 'login_attempts')).toBe(0);
  });
});

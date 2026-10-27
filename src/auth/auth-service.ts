/**
 * Auth service: account creation, credential checks with lockout, and server-side sessions.
 *
 * It orchestrates the pure rules in this module (`password-policy`, `lockout`, `session-policy`,
 * `tokens`) over the data-access facade. Every instant comes from the injected `Clock`, and the
 * service holds no state beyond its factory closure. It receives no logger and logs nothing, so no
 * password, hash or session token can reach a log from here.
 */

import bcrypt from 'bcrypt';

import type { DataAccess, TxRepos } from '../db/data-access';
import type { SessionLimits, UserId } from '../db/types';
import type { Clock } from '../shared/clock';

import { evaluateLockout, LOCKOUT_THRESHOLD } from './lockout';
import {
  MAX_PASSWORD_BYTES,
  normalizeEmail,
  validateEmail,
  validatePassword,
} from './password-policy';
import { computeExpiresAt, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './session-policy';
import { generateSessionToken, hashSessionToken } from './tokens';

/** bcrypt cost factor for every stored password hash; stored hashes begin with `$2b$12$`. */
export const BCRYPT_COST = 12;

/** Age after which failed-login rows are deleted by {@link AuthService.purgeExpired}: 24 hours. */
export const LOGIN_ATTEMPT_RETENTION_MS = 86_400_000;

/** Any character outside ASCII (U+0000 to U+007F). */
const NON_ASCII_PATTERN = /[^\u0000-\u007f]/;

/**
 * The signed-in user attached to a request once its session has been authenticated.
 *
 * It deliberately carries no password or hash field, so templates can never receive one.
 */
export interface AuthenticatedUser {
  /** The user's id, the owner key for every task operation. */
  id: UserId;
  /** The email as stored at sign-up: trimmed, with its case as entered. */
  email: string;
  /**
   * Lowercase hex of the SHA-256 session-token hash (the `sessions.id` key). It is used only as
   * the CSRF binding and is never rendered; the raw token is not recoverable from it.
   */
  sessionId: string;
}

/** An email and password exactly as submitted on the sign-up or login form. */
export interface CredentialsInput {
  /** The submitted email, untrimmed. */
  email: string;
  /** The submitted password; never trimmed, logged or stored in plain text. */
  password: string;
}

/**
 * Outcome of {@link AuthService.signUp}.
 *
 * - `{ ok: true }`: the account was created; sign-up does not log the user in.
 * - `reason: 'invalid'`: the email or password failed its policy; `errors` holds the message for
 *   each failing field only.
 * - `reason: 'duplicate'`: an account already exists for the email, ignoring case.
 */
export type SignUpResult =
  | { ok: true }
  | { ok: false; reason: 'invalid'; errors: { email?: string; password?: string } }
  | { ok: false; reason: 'duplicate' };

/**
 * Outcome of {@link AuthService.logIn}.
 *
 * - `{ ok: true }`: a new session was created; `sessionToken` is the raw token for the signed
 *   `sid` cookie and must never be logged, rendered or put in a redirect.
 * - `reason: 'invalid'`: blank input, an unknown email or a wrong password, which callers must not
 *   tell apart.
 * - `reason: 'locked'`: the email is refused after too many recent failures.
 */
export type LogInResult =
  | { ok: true; sessionToken: string; user: AuthenticatedUser }
  | { ok: false; reason: 'invalid' | 'locked' };

/** Row counts deleted by one {@link AuthService.purgeExpired} run. */
export interface PurgeResult {
  /** Expired sessions deleted. */
  sessions: number;
  /** Failed-login rows older than {@link LOGIN_ATTEMPT_RETENTION_MS} deleted. */
  loginAttempts: number;
}

/** Accounts, credential checks, lockout and session lifecycle. */
export interface AuthService {
  /**
   * Creates an account after re-checking the email and password policies, hashing the password
   * with bcrypt at {@link BCRYPT_COST}.
   *
   * @param input - The submitted email and password.
   * @returns The discriminated outcome; expected failures are never thrown.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  signUp(input: CredentialsInput): Promise<SignUpResult>;

  /**
   * Checks credentials under the per-email login lock and, on success, clears the email's
   * failures and creates a session, all in one transaction.
   *
   * @param input - The submitted email and password.
   * @returns The discriminated outcome; expected failures are never thrown.
   * @throws `DatabaseUnavailableError` when the database cannot be reached; nothing is committed.
   */
  logIn(input: CredentialsInput): Promise<LogInResult>;

  /**
   * Resolves a session token to its user and records the request as activity, atomically. An
   * expired session is deleted; an unknown token changes nothing.
   *
   * @param sessionToken - The raw token from a validly signed `sid` cookie.
   * @returns The signed-in user, or `null` when the token is unknown or the session has expired.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  authenticate(sessionToken: string): Promise<AuthenticatedUser | null>;

  /**
   * Deletes the session for a token whatever its state. An unknown token deletes nothing.
   *
   * @param sessionToken - The raw token from the `sid` cookie.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  logOut(sessionToken: string): Promise<void>;

  /**
   * Deletes expired sessions and failed-login rows older than
   * {@link LOGIN_ATTEMPT_RETENTION_MS}, for the scheduled purge job, which catches and logs any
   * rejection.
   *
   * @returns How many rows of each kind were deleted.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  purgeExpired(): Promise<PurgeResult>;
}

/** What {@link createAuthService} needs: the data-access facade and the clock. */
export interface AuthServiceDeps {
  /** The data-access facade; logins run inside its `withLoginLock`. */
  dal: DataAccess;
  /** The single source of the current time for every session and lockout rule. */
  clock: Clock;
}

/**
 * Creates the auth service.
 *
 * Construction starts one bcrypt hash of a random value in the background, the dummy hash that
 * unknown emails are compared against.
 *
 * @param deps - The data-access facade and the clock.
 * @returns The service; all of its state lives in this closure.
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { dal, clock } = deps;

  // Comparing against this hash when the email has no account makes a login cost one cost-12
  // bcrypt comparison either way, so response time does not reveal whether an account exists.
  // Its input is random and never disclosed, so no submitted password can match it.
  const dummyHash: Promise<string> = bcrypt.hash(generateSessionToken(), BCRYPT_COST);
  // Marks the promise handled, so a failure before the first login awaits it is never an
  // unhandled rejection; logIn still awaits the original promise and sees that failure.
  dummyHash.catch(() => undefined);

  // session-policy.ts stays the single source of both limits; the SQL holds no durations.
  const limits: SessionLimits = { absoluteMs: SESSION_ABSOLUTE_MS, idleMs: SESSION_IDLE_MS };

  /**
   * The serialised part of a login, run while the login lock for `key` is held.
   *
   * `key` is the normalised email and the only value the attempt uses: it is the lockout key the
   * failures are read and recorded under, and the account is looked up by it too.
   *
   * Every statement goes through `tx`: the top-level repositories run on other pooled
   * connections, outside the locked transaction, which would break the serialisation.
   */
  async function attemptLogin(tx: TxRepos, key: string, password: string): Promise<LogInResult> {
    // Taken inside the lock, so the time reflects when the serialised work actually runs.
    const now = clock.now();

    const failures = await tx.loginAttempts.latestFailures(key, LOCKOUT_THRESHOLD);
    if (evaluateLockout(failures, now).locked) {
      // A refused attempt is never recorded and does not count, so retrying cannot extend the
      // refusal. The password is never checked, so the refusal holds even when it is correct.
      return { ok: false, reason: 'locked' };
    }

    // The account is looked up by the lockout key itself, so the lookup and the lockout always
    // agree on which email an attempt is for. Sign-up accepts ASCII emails only, and outside ASCII
    // JavaScript's toLowerCase and PostgreSQL's lower() disagree ('İ', U+0130, becomes 'i' plus
    // U+0307 here but plain 'i' in SQL), so a non-ASCII key is never looked up: a variant spelling
    // would otherwise reach an account under a fresh lockout key. It takes the no-account path,
    // compared against the dummy hash and recorded under its own key like any unknown email.
    const creds = NON_ASCII_PATTERN.test(key) ? null : await tx.users.findCredentialsByEmail(key);
    // A password over the byte limit can never be a stored one, since sign-up rejects it, and
    // bcrypt would silently compare only its first 72 bytes and could accept it. It is treated
    // as wrong, compared against the dummy hash so its timing matches any other failure.
    const tooLong = Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES;
    const account = tooLong ? null : creds;
    const matched = await bcrypt.compare(
      password,
      account === null ? await dummyHash : account.passwordHash,
    );

    if (account === null || !matched) {
      // Failures for emails with no account are recorded the same way, so the lockout reveals
      // nothing about which emails are registered. The fifth failure still gets 'invalid'; the
      // sixth attempt is the first one refused.
      await tx.loginAttempts.record(key, now);
      return { ok: false, reason: 'invalid' };
    }

    // A fresh token at every login prevents session fixation. Clearing the failures and creating
    // the session commit together in this locked transaction.
    await tx.loginAttempts.clear(key);
    const sessionToken = generateSessionToken();
    const idHash = hashSessionToken(sessionToken);
    await tx.sessions.insert({
      idHash,
      userId: account.id,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: computeExpiresAt(now, now),
    });
    return {
      ok: true,
      sessionToken,
      user: { id: account.id, email: account.email, sessionId: idHash.toString('hex') },
    };
  }

  return {
    async signUp(input: CredentialsInput): Promise<SignUpResult> {
      // Re-checked here although the web form validator already ran the same rules, so no path
      // can store an account the policies reject.
      const emailError = validateEmail(input.email);
      const passwordError = validatePassword(input.password);
      if (emailError !== null || passwordError !== null) {
        const errors: { email?: string; password?: string } = {};
        if (emailError !== null) {
          errors.email = emailError;
        }
        if (passwordError !== null) {
          errors.password = passwordError;
        }
        return { ok: false, reason: 'invalid', errors };
      }

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
      // Stored trimmed with its case as entered; the unique index on lower(email) enforces
      // case-insensitive uniqueness, even when two sign-ups race.
      const inserted = await dal.users.insert({
        email: input.email.trim(),
        passwordHash,
        createdAt: clock.now(),
      });
      if (inserted === 'duplicate') {
        return { ok: false, reason: 'duplicate' };
      }
      return { ok: true };
    },

    async logIn(input: CredentialsInput): Promise<LogInResult> {
      const email = input.email.trim();
      // A blank email or password gets the generic message without taking the lock and is not
      // recorded as a failure, so it never counts towards the lockout.
      if (email === '' || input.password === '') {
        return { ok: false, reason: 'invalid' };
      }
      const key = normalizeEmail(input.email);
      return dal.withLoginLock(key, (tx) => attemptLogin(tx, key, input.password));
    },

    async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
      const idHash = hashSessionToken(sessionToken);
      const now = clock.now();
      // One atomic UPDATE both checks expiry and records the activity, so concurrent requests on
      // a session are serialised by its row lock rather than by anything here.
      const record = await dal.sessions.touchIfActive(idHash, now, limits);
      if (record === null) {
        // Removes the row only if it has expired; an unknown token deletes nothing.
        await dal.sessions.deleteIfExpired(idHash, now);
        return null;
      }
      return { id: record.userId, email: record.userEmail, sessionId: idHash.toString('hex') };
    },

    async logOut(sessionToken: string): Promise<void> {
      await dal.sessions.delete(hashSessionToken(sessionToken));
    },

    async purgeExpired(): Promise<PurgeResult> {
      const now = clock.now();
      const sessions = await dal.sessions.deleteExpired(now);
      const loginAttempts = await dal.loginAttempts.purgeBefore(
        new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS),
      );
      return { sessions, loginAttempts };
    },
  };
}

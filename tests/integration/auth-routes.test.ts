/**
 * Integration tests for the account routes `/signup`, `/login` and `/logout`, run against the
 * real application stack and PostgreSQL 16 (plan 0.9.1: SC1, SC2 and SC11 at this level).
 *
 * Covered: sign-up and login success with the stored session row, cookie attributes per
 * `NODE_ENV`, validation and duplicate emails, the generic invalid-credentials answer, the
 * lockout timeline under the fake clock, the lockout key across email spellings (ASCII case
 * variants share the account's key, and U+0130 variants never reach the account), login
 * serialisation within one instance and across two (two instances with separate pools are how
 * replicas are emulated, plan 0.9.2), the login lock's cost (same-email calls queued in process
 * hold no pooled client, and a connection failure fails the calls queued behind it at once),
 * CSRF on every form, the return path, logout, and signed-in users kept away from the anonymous
 * pages.
 *
 * Accepted sign-ups hash at cost 12; eligible credential checks use bcrypt.compare. Each test
 * signs up at most two users. Messages are asserted verbatim against local constants, not the
 * application's own, so a reworded message fails here.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runInThisContext } from 'node:vm';

import type { Pool } from 'pg';

import { createDataAccess } from '../../src/db/data-access';
import type { TxRepos } from '../../src/db/data-access';
import { DatabaseUnavailableError } from '../../src/shared/errors';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import { parseSetCookie, rawSessionToken, signCookieValue } from '../helpers/http-client';
import type { HttpClient, HttpResult, ParsedSetCookie } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import {
  countRows,
  createTestPool,
  insertLoginFailures,
  loginAttemptRows,
  sessionsForUser,
  sql,
  truncateAll,
  userIdByEmail,
} from '../helpers/test-db';

const ACCOUNT_CREATED = 'Your account has been created. Log in to continue.';
const EMAIL_INVALID = 'Enter a valid email address.';
const PASSWORD_POLICY =
  'Password must be at least 10 characters and contain a letter and a digit.';
const PASSWORD_TOO_LONG = 'Password is too long (maximum 72 bytes).';
const DUPLICATE_EMAIL = 'An account with this email already exists.';
const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const LOCKED_OUT = 'Too many failed attempts. Try again later.';
const CSRF_EXPIRED = 'The form has expired. Reload the page and try again.';

const MINUTE_MS = 60_000;

/** The lockout window and refusal period: 15 minutes. */
const LOCKOUT_MS = 15 * MINUTE_MS;

/** The idle limit that bounds a fresh session's `expires_at`: 30 minutes. */
const IDLE_MS = 30 * MINUTE_MS;

/** `Max-Age` of the session cookie, the 8-hour absolute limit in seconds. */
const SESSION_MAX_AGE_SECONDS = 28_800;

/** A CSRF token a form submission must not be accepted with: missing, or not the HMAC. */
interface BadToken {
  label: string;
  csrf: string | false;
}

const BAD_TOKENS: readonly BadToken[] = [
  { label: 'missing', csrf: false },
  { label: 'wrong', csrf: 'wrong' },
];

/**
 * The host process. Jest gives each test file its own copy of `process`, and listeners added to
 * that copy never receive the real process's events, so an `unhandledRejection` spy on it could
 * never fire. `runInThisContext` evaluates in Node's main context, whose `process` is the real one.
 */
const hostProcess = runInThisContext('process') as NodeJS.Process;

/** A fresh address, so no two tests or cases can collide on the unique email index. */
function uniqueEmail(): string {
  return `auth-${randomUUID()}@example.test`;
}

/**
 * A fresh policy-compliant password. It is alphanumeric, so HTML escaping and URL encoding leave
 * it unchanged and the "never echoed" checks compare it exactly.
 */
function newPassword(): string {
  return 'Pw' + randomBytes(12).toString('hex') + '9';
}

/** The lockout key `login_attempts` stores for an email: trimmed and lower-cased. */
function lockoutKey(email: string): string {
  return email.trim().toLowerCase();
}

function newClient(target: TestApp): HttpClient {
  return target.client();
}

/** The form fields of the sign-up and login forms, with `next` only when one is given. */
function credentialFields(
  email: string,
  password: string,
  next: string | undefined,
): Record<string, string> {
  return next === undefined ? { email, password } : { email, password, next };
}

/** Opens the sign-up page, which yields the anonymous CSRF token, and submits the form. */
async function signUp(
  client: HttpClient,
  email: string,
  password: string,
  next?: string,
): Promise<HttpResult> {
  const page = await client.get('/signup');
  expect(page.status).toBe(200);
  return client.post('/signup', credentialFields(email, password, next));
}

/** Opens the login page, which yields the anonymous CSRF token, and submits the form. */
async function logIn(
  client: HttpClient,
  email: string,
  password: string,
  next?: string,
): Promise<HttpResult> {
  const page = await client.get('/login');
  expect(page.status).toBe(200);
  return client.post('/login', credentialFields(email, password, next));
}

/**
 * Opens the login page and returns its anonymous CSRF token, so later posts can pass it
 * explicitly: concurrent posts on one client then cannot depend on which page arrived last.
 */
async function fetchAnonToken(client: HttpClient): Promise<string> {
  const page = await client.get('/login');
  expect(page.status).toBe(200);
  const token = client.csrfToken();
  if (token === null) {
    throw new Error('the login page carries no CSRF token');
  }
  return token;
}

/** The parsed `Set-Cookie` of `name` in a response, or `undefined` when none was sent. */
function cookieNamed(result: HttpResult, name: string): ParsedSetCookie | undefined {
  return result.setCookies.map(parseSetCookie).find((cookie) => cookie.name === name);
}

function requireSetCookie(result: HttpResult, name: string): ParsedSetCookie {
  const cookie = cookieNamed(result, name);
  if (cookie === undefined) {
    throw new Error(`the response sets no ${name} cookie`);
  }
  return cookie;
}

/** The raw `sid` value a client holds, failing the test when it holds none. */
function requireSid(client: HttpClient): string {
  const sid = client.cookie('sid');
  if (sid === undefined) {
    throw new Error('the client holds no sid cookie');
  }
  return sid;
}

async function userIdOf(db: Pool, email: string): Promise<number> {
  const id = await userIdByEmail(db, email);
  if (id === null) {
    throw new Error('no user has this email');
  }
  return id;
}

/** The SHA-256 of the token in a `sid` cookie value: the `sessions.id` key of its row. */
function sessionIdHash(sidCookieValue: string): Buffer {
  return createHash('sha256').update(rawSessionToken(sidCookieValue)).digest();
}

function sortedStatuses(results: readonly HttpResult[]): number[] {
  return results.map((result) => result.status).sort((a, b) => a - b);
}

/** The attributes both cookies share, plus `Secure` and `Max-Age`, which depend on the cookie. */
function expectCookieAttributes(
  cookie: ParsedSetCookie,
  expected: { secure: boolean; maxAge: number | null },
): void {
  expect({
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    path: cookie.path,
    secure: cookie.secure,
    maxAge: cookie.maxAge,
  }).toEqual({ httpOnly: true, sameSite: 'Lax', path: '/', ...expected });
}

let clock: FakeClock;
let app: TestApp;
let pool: Pool;

beforeAll(async () => {
  clock = new FakeClock();
  app = await startTestApp({ clock });
  pool = createTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  clock.set(FAKE_CLOCK_START);
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await pool.end();
  }
});

/**
 * Signs a fresh user up and in on a new client of `target`, then opens `/tasks`, so the client
 * holds the session-bound CSRF token an authenticated form needs.
 */
async function signedInUser(
  target: TestApp = app,
): Promise<{ client: HttpClient; email: string; password: string; userId: number }> {
  const email = uniqueEmail();
  const password = newPassword();
  const client = newClient(target);
  expect((await signUp(client, email, password)).status).toBe(303);
  const login = await logIn(client, email, password);
  expect(login.status).toBe(303);
  expect((await client.get('/tasks')).status).toBe(200);
  return { client, email, password, userId: await userIdOf(target.pool, email) };
}

describe('sign-up and login (SC1)', () => {
  test('sign-up stores the email trimmed, case kept, and redirects to the notice', async () => {
    const email = `Auth-${randomUUID()}@Example.test`;
    const res = await signUp(newClient(app), `  ${email}  `, newPassword());

    expect(res.status).toBe(303);
    expect(res.location).toBe('/login?created=1');
    expect(await countRows(pool, 'users')).toBe(1);
    const stored = await sql<{ email: string }>(pool, 'SELECT email FROM users');
    expect(stored.map((row) => row.email)).toEqual([email]);
  });

  test('the login page shows the account-created notice only for created=1', async () => {
    const client = newClient(app);

    const created = await client.get('/login?created=1');
    expect(created.status).toBe(200);
    expect(created.body).toContain(ACCOUNT_CREATED);

    const plain = await client.get('/login');
    expect(plain.status).toBe(200);
    expect(plain.body).not.toContain(ACCOUNT_CREATED);
  });

  test('login sets a signed sid cookie, opens /tasks and stores one session row', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);

    const res = await logIn(client, email, password);
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks');
    const sid = requireSetCookie(res, 'sid');
    expect(decodeURIComponent(sid.value).startsWith('s:')).toBe(true);
    expect((await client.get('/tasks')).status).toBe(200);

    const now = clock.now().getTime();
    const sessions = await sessionsForUser(pool, await userIdOf(pool, email));
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(
      session && {
        createdAt: session.createdAt.getTime(),
        lastActiveAt: session.lastActiveAt.getTime(),
        expiresAt: session.expiresAt.getTime(),
      },
    ).toEqual({ createdAt: now, lastActiveAt: now, expiresAt: now + IDLE_MS });
  });
});

describe('cookie attributes (plan 0.3.4)', () => {
  /**
   * Checks the `csrf` cookie of the first page a fresh client opens on `target`, then the `sid`
   * cookie its login sets. Only `Secure` differs between modes.
   */
  async function expectCookiesOf(target: TestApp, secure: boolean): Promise<void> {
    const client = newClient(target);
    const firstPage = await client.get('/login');
    expect(firstPage.status).toBe(200);
    const csrf = requireSetCookie(firstPage, 'csrf');
    expectCookieAttributes(csrf, { secure, maxAge: null });
    // No Max-Age and no Expires: the nonce lives for the browser session.
    expect(csrf.expires).toBeNull();

    const email = uniqueEmail();
    const password = newPassword();
    expect((await signUp(client, email, password)).status).toBe(303);
    const login = await logIn(client, email, password);
    expect(login.status).toBe(303);
    expectCookieAttributes(requireSetCookie(login, 'sid'), {
      secure,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }

  test('outside production: HttpOnly, SameSite=Lax and Path=/, without Secure', async () => {
    expect(app.config.nodeEnv).toBe('test');
    await expectCookiesOf(app, false);
  });

  test('in production both cookies also carry Secure', async () => {
    const production = await startTestApp({ clock, nodeEnv: 'production' });
    try {
      await expectCookiesOf(production, true);
    } finally {
      await production.close();
    }
  });
});

describe('sign-up validation and duplicates', () => {
  test.each([
    {
      label: 'an invalid email',
      email: 'not-an-email',
      password: newPassword(),
      message: EMAIL_INVALID,
    },
    {
      label: 'a short password',
      email: uniqueEmail(),
      password: 'abc123',
      message: PASSWORD_POLICY,
    },
    {
      label: 'a password without a digit',
      email: uniqueEmail(),
      password: 'abcdefghijkl',
      message: PASSWORD_POLICY,
    },
    {
      label: 'a 73-byte password',
      email: uniqueEmail(),
      password: 'a1' + 'b'.repeat(71),
      message: PASSWORD_TOO_LONG,
    },
  ])('$label is refused with 422, keeps the email and never echoes the password', async (row) => {
    const res = await signUp(newClient(app), row.email, row.password);

    expect(res.status).toBe(422);
    expect(res.body).toContain(row.message);
    expect(res.body).toContain(`value="${row.email}"`);
    expect(res.body).not.toContain(row.password);
    expect(await countRows(pool, 'users')).toBe(0);
  });

  test('the same email in another case gets 409 and creates no second account', async () => {
    const email = `Case-${randomUUID()}@Example.test`;
    const client = newClient(app);
    expect((await signUp(client, email, newPassword())).status).toBe(303);

    const again = email.toLowerCase();
    const res = await signUp(client, again, newPassword());
    expect(res.status).toBe(409);
    expect(res.body).toContain(DUPLICATE_EMAIL);
    expect(res.body).toContain(`value="${again}"`);
    expect(await countRows(pool, 'users')).toBe(1);
  });
});

describe('invalid credentials and blank fields (SC2, FR-2)', () => {
  test('a wrong password and an unknown email both get 422 with the generic message', async () => {
    const email = uniqueEmail();
    const client = newClient(app);
    expect((await signUp(client, email, newPassword())).status).toBe(303);

    const wrongPassword = await logIn(client, email, newPassword());
    const unknownEmail = await logIn(client, uniqueEmail(), newPassword());
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(422);
      expect(res.body).toContain(INVALID_CREDENTIALS);
      expect(cookieNamed(res, 'sid')).toBeUndefined();
    }
  });

  test('the answer is byte-identical whether or not the account exists', async () => {
    // One client and one email throughout, so the CSRF nonce, the token and the re-rendered email
    // are the same in both responses and only account existence differs.
    const email = uniqueEmail();
    const wrong = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, newPassword())).status).toBe(303);
    const token = await fetchAnonToken(client);

    const withAccount = await client.post('/login', { email, password: wrong }, { csrf: token });
    // The user-delete trigger also removes the email's recorded failure.
    await sql(pool, 'DELETE FROM users WHERE lower(email) = lower($1)', [email]);
    expect(await loginAttemptRows(pool, lockoutKey(email))).toHaveLength(0);
    const withoutAccount = await client.post('/login', { email, password: wrong }, { csrf: token });

    expect(withAccount.status).toBe(422);
    expect(withoutAccount.status).toBe(422);
    expect(withAccount.body).toContain(INVALID_CREDENTIALS);
    expect(withoutAccount.body).toBe(withAccount.body);
    // Failures for an email with no account are recorded the same way.
    expect(await loginAttemptRows(pool, lockoutKey(email))).toHaveLength(1);
  });

  test.each([
    { label: 'a blank email', email: '', password: newPassword() },
    { label: 'a blank password', email: uniqueEmail(), password: '' },
  ])('$label gets 422 with the generic message and is not recorded', async (row) => {
    const res = await logIn(newClient(app), row.email, row.password);

    expect(res.status).toBe(422);
    expect(res.body).toContain(INVALID_CREDENTIALS);
    expect(await countRows(pool, 'login_attempts')).toBe(0);
  });
});

describe('lockout timeline (SC2, plan 0.3.4)', () => {
  test('five failures refuse even the correct password for exactly 15 minutes', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const wrong = newPassword();
    const key = lockoutKey(email);
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);
    const userId = await userIdOf(pool, email);
    const token = await fetchAnonToken(client);
    const attempt = (submitted: string): Promise<HttpResult> =>
      client.post('/login', { email, password: submitted }, { csrf: token });

    // The fifth failure still shows the generic message; the sixth attempt is the first refused.
    for (let failure = 1; failure <= 5; failure += 1) {
      const res = await attempt(wrong);
      expect(res.status).toBe(422);
      expect(res.body).toContain(INVALID_CREDENTIALS);
    }
    expect(await loginAttemptRows(pool, key)).toHaveLength(5);

    const locked = await attempt(password);
    expect(locked.status).toBe(429);
    expect(locked.body).toContain(LOCKED_OUT);
    expect(cookieNamed(locked, 'sid')).toBeUndefined();
    expect(await sessionsForUser(pool, userId)).toHaveLength(0);
    // Refused attempts are not recorded, so retrying cannot extend the refusal.
    expect(await loginAttemptRows(pool, key)).toHaveLength(5);

    clock.advance(LOCKOUT_MS - 1);
    const stillLocked = await attempt(password);
    expect(stillLocked.status).toBe(429);
    expect(stillLocked.body).toContain(LOCKED_OUT);
    expect(await loginAttemptRows(pool, key)).toHaveLength(5);

    // Exactly the fifth failure plus 15 minutes: the refusal has ended.
    clock.advance(1);
    const unlocked = await attempt(password);
    expect(unlocked.status).toBe(303);
    expect(unlocked.location).toBe('/tasks');
    expect(await loginAttemptRows(pool, key)).toHaveLength(0);
    expect(await sessionsForUser(pool, userId)).toHaveLength(1);
  });

  test('five failures spanning more than 15 minutes do not lock', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const wrong = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);
    const token = await fetchAnonToken(client);
    const attempt = (submitted: string): Promise<HttpResult> =>
      client.post('/login', { email, password: submitted }, { csrf: token });

    const start = clock.now().getTime();
    const offsets = [0, 4 * MINUTE_MS, 8 * MINUTE_MS, 12 * MINUTE_MS, LOCKOUT_MS + 1];
    for (const offset of offsets) {
      clock.set(new Date(start + offset));
      expect((await attempt(wrong)).status).toBe(422);
    }
    expect(await loginAttemptRows(pool, lockoutKey(email))).toHaveLength(5);

    const res = await attempt(password);
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks');
  });
});

describe('lockout key across email spellings (plan 0.3.4)', () => {
  // JavaScript lower-cases U+0130 to i plus U+0307; PostgreSQL may fold it to plain i.
  // Credential lookup and lockout must share the normalized key, so these spellings cannot
  // authenticate a canonical account through a separate failure history.

  /** The registered account's email, which is also its lockout key. */
  const CANONICAL_EMAIL = 'victim@example.com';

  /** Gap between consecutive attempts, well inside the 15-minute lockout window. */
  const ATTEMPT_GAP_MS = 1_000;

  /**
   * Spellings of {@link CANONICAL_EMAIL} with U+0130 in place of 'i'. PostgreSQL's `lower()`
   * folds each to the canonical email, while {@link lockoutKey} gives a different, non-ASCII key.
   */
  const U0130_VARIANTS: readonly string[] = [
    'v\u0130ctim@example.com',
    'vict\u0130m@example.com',
    'v\u0130ct\u0130m@example.com',
    'V\u0130CT\u0130M@EXAMPLE.COM',
  ];

  /** The signed-up account and the anonymous client every attempt of a case posts from. */
  interface Victim {
    client: HttpClient;
    token: string;
    password: string;
    userId: number;
  }

  /** Signs the canonical email up through the form, so its hash is a real cost-12 one. */
  async function signUpVictim(): Promise<Victim> {
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, CANONICAL_EMAIL, password)).status).toBe(303);
    const userId = await userIdOf(pool, CANONICAL_EMAIL);
    return { client, token: await fetchAnonToken(client), password, userId };
  }

  /** Posts one login for `email`, a second after the previous attempt. */
  function attemptAfterGap(victim: Victim, email: string, password: string): Promise<HttpResult> {
    clock.advance(ATTEMPT_GAP_MS);
    return victim.client.post('/login', { email, password }, { csrf: victim.token });
  }

  /** Fails one login for `email` with a wrong password, a second after the previous attempt. */
  async function failLogin(victim: Victim, email: string): Promise<void> {
    const res = await attemptAfterGap(victim, email, newPassword());
    expect(res.status).toBe(422);
    expect(res.body).toContain(INVALID_CREDENTIALS);
  }

  test.each(U0130_VARIANTS)(
    'PostgreSQL lower() folds %j to the canonical email, but the lockout key does not',
    async (variant) => {
      const rows = await sql<{ lowered: string }>(pool, 'SELECT lower($1::text) AS lowered', [
        variant,
      ]);
      expect(rows).toEqual([{ lowered: CANONICAL_EMAIL }]);
      expect(lockoutKey(variant)).not.toBe(CANONICAL_EMAIL);
    },
  );

  test.each(U0130_VARIANTS)(
    'refuses %j with the correct password while the canonical email is locked',
    async (variant) => {
      const victim = await signUpVictim();
      for (let failure = 1; failure <= 5; failure += 1) {
        await failLogin(victim, CANONICAL_EMAIL);
      }
      const canonicalRows = await loginAttemptRows(pool, CANONICAL_EMAIL);
      expect(canonicalRows).toHaveLength(5);

      // Either refusal will do here; the unknown-email cases below pin down which one it is.
      const refused = await attemptAfterGap(victim, variant, victim.password);
      expect([422, 429]).toContain(refused.status);
      expect(refused.body).toContain(refused.status === 429 ? LOCKED_OUT : INVALID_CREDENTIALS);
      expect(cookieNamed(refused, 'sid')).toBeUndefined();
      expect(await countRows(pool, 'sessions')).toBe(0);

      const locked = await attemptAfterGap(victim, CANONICAL_EMAIL, victim.password);
      expect(locked.status).toBe(429);
      expect(locked.body).toContain(LOCKED_OUT);
      expect(await countRows(pool, 'sessions')).toBe(0);
      expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual(canonicalRows);
    },
  );

  test.each(U0130_VARIANTS)(
    'treats %j with the correct password as an unknown email under its own key',
    async (variant) => {
      const victim = await signUpVictim();
      await failLogin(victim, CANONICAL_EMAIL);
      const canonicalRows = await loginAttemptRows(pool, CANONICAL_EMAIL);
      expect(canonicalRows).toHaveLength(1);

      const res = await attemptAfterGap(victim, variant, victim.password);
      expect(res.status).toBe(422);
      expect(res.body).toContain(INVALID_CREDENTIALS);

      const variantRows = await loginAttemptRows(pool, lockoutKey(variant));
      expect(variantRows).toHaveLength(1);
      expect(variantRows[0]?.failedAt).toEqual(clock.now());
      expect(await countRows(pool, 'login_attempts')).toBe(2);
      expect(await countRows(pool, 'sessions')).toBe(0);
      expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual(canonicalRows);
    },
  );

  test('logs in with an ASCII case variant and clears the canonical failures', async () => {
    const victim = await signUpVictim();
    await failLogin(victim, CANONICAL_EMAIL);
    await failLogin(victim, 'Victim@Example.com');
    expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toHaveLength(2);

    const res = await attemptAfterGap(victim, '  VICTIM@Example.COM  ', victim.password);
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks');
    expect(cookieNamed(res, 'sid')).toBeDefined();
    expect(await sessionsForUser(pool, victim.userId)).toHaveLength(1);
    expect(await countRows(pool, 'sessions')).toBe(1);
    expect(await loginAttemptRows(pool, CANONICAL_EMAIL)).toEqual([]);
    expect(await countRows(pool, 'login_attempts')).toBe(0);
    // The new session is the canonical account's: the task list names its email.
    const tasks = await victim.client.get('/tasks');
    expect(tasks.status).toBe(200);
    expect(tasks.body).toContain(`Signed in as ${CANONICAL_EMAIL}`);
  });
});

describe('login serialisation (plan 0.9.2)', () => {
  /** Records four failures for `key`, 4, 3, 2 and 1 minutes before the clock's instant. */
  async function seedFourFailures(key: string): Promise<void> {
    const now = clock.now().getTime();
    const dates = [4, 3, 2, 1].map((minutes) => new Date(now - minutes * MINUTE_MS));
    await insertLoginFailures(pool, key, dates);
  }

  test('threshold race: three concurrent failures after four give 422, 429, 429', async () => {
    const email = uniqueEmail();
    const key = lockoutKey(email);
    const client = newClient(app);
    expect((await signUp(client, email, newPassword())).status).toBe(303);
    await seedFourFailures(key);
    const token = await fetchAnonToken(client);
    const wrong = newPassword();

    const results = await Promise.all(
      [1, 2, 3].map(() => client.post('/login', { email, password: wrong }, { csrf: token })),
    );

    expect(sortedStatuses(results)).toEqual([422, 429, 429]);
    expect(await loginAttemptRows(pool, key)).toHaveLength(5);
  });

  test('replica race: ten attempts across two instances record exactly five failures', async () => {
    const clock2 = new FakeClock(clock.now());
    const app2 = await startTestApp({ clock: clock2 });
    try {
      // No account exists for this email: unknown emails are serialised and locked alike.
      const email = uniqueEmail();
      const wrong = newPassword();
      const client1 = newClient(app);
      const client2 = newClient(app2);
      // Each instance has its own secret, so each client posts its own instance's token.
      const [token1, token2] = await Promise.all([
        fetchAnonToken(client1),
        fetchAnonToken(client2),
      ]);

      const posts: Promise<HttpResult>[] = [];
      for (let pair = 0; pair < 5; pair += 1) {
        posts.push(client1.post('/login', { email, password: wrong }, { csrf: token1 }));
        posts.push(client2.post('/login', { email, password: wrong }, { csrf: token2 }));
      }
      const results = await Promise.all(posts);

      expect(sortedStatuses(results)).toEqual([422, 422, 422, 422, 422, 429, 429, 429, 429, 429]);
      expect(await loginAttemptRows(pool, lockoutKey(email))).toHaveLength(5);
    } finally {
      await app2.close();
    }
  });

  test('mixed outcomes: concurrent correct and wrong passwords end in a serial order', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const key = lockoutKey(email);
    expect((await signUp(newClient(app), email, password)).status).toBe(303);
    const userId = await userIdOf(pool, email);
    await seedFourFailures(key);
    const correctClient = newClient(app);
    const wrongClient = newClient(app);
    const [correctToken, wrongToken] = await Promise.all([
      fetchAnonToken(correctClient),
      fetchAnonToken(wrongClient),
    ]);

    const [correct, wrong] = await Promise.all([
      correctClient.post('/login', { email, password }, { csrf: correctToken }),
      wrongClient.post('/login', { email, password: newPassword() }, { csrf: wrongToken }),
    ]);
    const sessions = (await sessionsForUser(pool, userId)).length;
    const failures = (await loginAttemptRows(pool, key)).length;

    // (correct status, wrong status, session rows, failure rows). Any tuple other than the two
    // serial orders fails, a 303 that leaves no failure row (a lost failure) included.
    const observed = [correct.status, wrong.status, sessions, failures].join(',');
    if (observed === '303,422,1,1') {
      // Correct first: it cleared the four failures, then the wrong attempt recorded one.
      expect(correct.location).toBe('/tasks');
      expect(wrong.body).toContain(INVALID_CREDENTIALS);
    } else if (observed === '429,422,0,5') {
      // Wrong first: the fifth failure locked the email before the correct attempt ran.
      expect(correct.body).toContain(LOCKED_OUT);
      expect(cookieNamed(correct, 'sid')).toBeUndefined();
      expect(wrong.body).toContain(INVALID_CREDENTIALS);
    } else {
      throw new Error(
        `not a serial outcome: (correct, wrong, sessions, failures) = (${observed})`,
      );
    }
  });
});

describe('login lock cost (plan 0.3.4)', () => {
  /** The pool's `max`: the test pool uses the application's `createPool` settings. */
  const POOL_MAX = 10;

  /** A promise that settles only when `open` is called. */
  interface Gate {
    readonly opened: Promise<void>;
    open(): void;
  }

  function createGate(): Gate {
    let markOpened: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    return { opened, open: () => markOpened() };
  }

  /** Clients checked out of `db` right now, whether in use or still connecting. */
  function checkedOut(db: Pool): number {
    return db.totalCount - db.idleCount;
  }

  /** A driver error for an unreachable server, the root cause a queued call must carry. */
  const CONNECTION_REFUSED = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
    code: 'ECONNREFUSED',
  });

  interface HolderFailure {
    label: string;
    error: Error;
    queuedRun: boolean;
  }

  const HOLDER_FAILURES: readonly HolderFailure[] = [
    {
      label: 'a connection failure',
      error: new DatabaseUnavailableError('Database unavailable', { cause: CONNECTION_REFUSED }),
      queuedRun: false,
    },
    { label: 'any other error', error: new Error('not a connection failure'), queuedRun: true },
  ];

  test('same-email calls queued behind a holder hold no client and run in order', async () => {
    expect(pool.options.max).toBe(POOL_MAX);
    const dal = createDataAccess(pool);
    const key = lockoutKey(uniqueEmail());
    const holderStarted = createGate();
    const releaseHolder = createGate();
    const order: number[] = [];
    let running = 0;
    let mostRunning = 0;

    /** Call `index`'s work: one statement on its transaction's client, as a login issues. */
    async function work(tx: TxRepos, index: number): Promise<number> {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      order.push(index);
      try {
        await tx.loginAttempts.latestFailures(key, 5);
        if (index === 0) {
          holderStarted.open();
          await releaseHolder.opened;
        }
        return index;
      } finally {
        running -= 1;
      }
    }

    const calls = [dal.withLoginLock(key, (tx) => work(tx, 0))];
    // More waiters than the pool has clients: each would exhaust it if it checked one out.
    const indexes = Array.from({ length: POOL_MAX + 2 }, (_, at) => at + 1);
    try {
      await holderStarted.opened;
      calls.push(...indexes.map((index) => dal.withLoginLock(key, (tx) => work(tx, index))));
      // One macrotask lets any waiter that was going to request a client do so.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(pool.waitingCount).toBe(0);
      expect(checkedOut(pool)).toBe(1);
      // Other users' statements, and logins for other emails, still find a client at once.
      await expect(sql<{ one: number }>(pool, 'SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
      const otherKey = lockoutKey(uniqueEmail());
      await expect(dal.withLoginLock(otherKey, async () => 'other')).resolves.toBe('other');
      expect(checkedOut(pool)).toBe(1);
      expect(order).toEqual([0]);

      releaseHolder.open();
      await expect(Promise.all(calls)).resolves.toEqual([0, ...indexes]);
      expect(order).toEqual([0, ...indexes]);
      expect(mostRunning).toBe(1);
      expect(checkedOut(pool)).toBe(0);
    } finally {
      // A failed expectation must not leave the holder's lock and client held for later tests.
      releaseHolder.open();
      await Promise.allSettled(calls);
    }
  });

  test.each(HOLDER_FAILURES)(
    'a holder failing with $label: the calls queued behind it, then a fresh call',
    async ({ error, queuedRun }) => {
      const dal = createDataAccess(pool);
      const key = lockoutKey(uniqueEmail());
      const holderStarted = createGate();
      const releaseHolder = createGate();
      const ran: number[] = [];
      // Registered on the host process, not on Jest's copy of `process`, so it would observe a
      // real unhandled rejection.
      const unhandled = jest.fn<void, [unknown, Promise<unknown>]>();
      hostProcess.on('unhandledRejection', unhandled);
      const holder = dal.withLoginLock(key, async (): Promise<number> => {
        ran.push(0);
        holderStarted.open();
        await releaseHolder.opened;
        throw error;
      });
      const indexes = [1, 2, 3];
      const queued: Promise<number>[] = [];
      // Counts the clients checked out of the pool once the holder has its own.
      let acquires = 0;
      const countAcquire = (): void => {
        acquires += 1;
      };
      try {
        await holderStarted.opened;
        pool.on('acquire', countAcquire);
        queued.push(
          ...indexes.map((index) =>
            dal.withLoginLock(key, async (): Promise<number> => {
              ran.push(index);
              return index;
            }),
          ),
        );

        releaseHolder.open();
        await expect(holder).rejects.toBe(error);
        const outcomes = await Promise.allSettled(queued);
        pool.off('acquire', countAcquire);

        if (queuedRun) {
          expect(outcomes).toEqual(indexes.map((value) => ({ status: 'fulfilled', value })));
          expect(ran).toEqual([0, ...indexes]);
          expect(acquires).toBe(indexes.length);
        } else {
          expect(acquires).toBe(0);
          // Each queued call fails at once with its own error around the root driver error,
          // without checking a client out or running its work.
          for (const outcome of outcomes) {
            const reason: unknown = outcome.status === 'rejected' ? outcome.reason : outcome;
            expect(reason).toBeInstanceOf(DatabaseUnavailableError);
            expect(reason).not.toBe(error);
            const cause = reason instanceof DatabaseUnavailableError ? reason.cause : reason;
            expect(cause).toBe(CONNECTION_REFUSED);
          }
          expect(ran).toEqual([0]);
        }

        // The queue is not left stuck: a later call for the email runs normally.
        await expect(
          dal.withLoginLock(key, async (): Promise<string> => {
            ran.push(4);
            return 'fresh';
          }),
        ).resolves.toBe('fresh');
        expect(ran.at(-1)).toBe(4);
        expect(checkedOut(pool)).toBe(0);
        // Node reports unhandled rejections once the microtask queue drains; one macrotask later
        // any would have reached the spy.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        // A failed expectation must not leave the holder's lock and client held for later tests.
        releaseHolder.open();
        await Promise.allSettled([holder, ...queued]);
        pool.off('acquire', countAcquire);
        hostProcess.off('unhandledRejection', unhandled);
      }
    },
  );
});

describe('CSRF protection (plan 0.3.4)', () => {
  test.each(BAD_TOKENS)('POST /signup with a $label token gets 403', async ({ csrf }) => {
    const client = newClient(app);
    expect((await client.get('/signup')).status).toBe(200);

    const res = await client.post(
      '/signup',
      { email: uniqueEmail(), password: newPassword() },
      { csrf },
    );

    expect(res.status).toBe(403);
    expect(res.body).toContain(CSRF_EXPIRED);
    expect(await countRows(pool, 'users')).toBe(0);
  });

  test.each(BAD_TOKENS)('POST /login with a $label token gets 403', async ({ csrf }) => {
    // Correct credentials, so only the token can stop the login.
    const email = uniqueEmail();
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);
    expect((await client.get('/login')).status).toBe(200);

    const res = await client.post('/login', { email, password }, { csrf });

    expect(res.status).toBe(403);
    expect(res.body).toContain(CSRF_EXPIRED);
    expect(cookieNamed(res, 'sid')).toBeUndefined();
    expect(await countRows(pool, 'sessions')).toBe(0);
    expect(await countRows(pool, 'login_attempts')).toBe(0);
  });

  test.each(BAD_TOKENS)(
    'an authenticated POST /logout with a $label token is refused and keeps the session',
    async ({ csrf }) => {
      const { client, userId } = await signedInUser();

      const res = await client.post('/logout', {}, { csrf });

      expect(res.status).toBe(403);
      expect(res.body).toContain(CSRF_EXPIRED);
      expect(await sessionsForUser(pool, userId)).toHaveLength(1);
      expect((await client.get('/tasks')).status).toBe(200);
    },
  );

  test('a token bound to anon before login is refused by POST /logout', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);
    const anonToken = await fetchAnonToken(client);
    const login = await client.post('/login', { email, password }, { csrf: anonToken });
    expect(login.status).toBe(303);

    const res = await client.post('/logout', {}, { csrf: anonToken });

    expect(res.status).toBe(403);
    expect(res.body).toContain(CSRF_EXPIRED);
    expect(await sessionsForUser(pool, await userIdOf(pool, email))).toHaveLength(1);
    expect((await client.get('/tasks')).status).toBe(200);
  });

  test(
    'POST /logout refuses a token rendered for another session of the same user and nonce',
    async () => {
      const { client: a, email, password, userId } = await signedInUser();
      const nonce = a.cookie('csrf');
      if (nonce === undefined) {
        throw new Error('client A holds no csrf cookie');
      }
      // B logs in holding A's nonce, so only the session binding can tell their tokens apart.
      const b = newClient(app);
      b.setCookie('csrf', nonce);
      expect((await logIn(b, email, password)).status).toBe(303);
      expect((await b.get('/tasks')).status).toBe(200);
      expect(b.cookie('csrf')).toBe(nonce);
      const sidA = requireSid(a);
      const sidB = requireSid(b);
      expect(sidB).not.toBe(sidA);
      const keyOf = (sid: string): string => sessionIdHash(sid).toString('hex');
      const bothKeys = [keyOf(sidA), keyOf(sidB)].sort();
      const sessionKeys = async (): Promise<string[]> =>
        (await sessionsForUser(pool, userId)).map((row) => row.idHash.toString('hex')).sort();
      expect(await sessionKeys()).toEqual(bothKeys);
      const aToken = a.csrfToken();
      const bToken = b.csrfToken();
      if (aToken === null || bToken === null) {
        throw new Error('a signed-in page carries no CSRF token');
      }

      const res = await b.post('/logout', {}, { csrf: aToken });

      expect(res.status).toBe(403);
      expect(res.body).toContain(CSRF_EXPIRED);
      expect(cookieNamed(res, 'sid')).toBeUndefined();
      expect(await sessionKeys()).toEqual(bothKeys);
      expect((await a.get('/tasks')).status).toBe(200);
      expect((await b.get('/tasks')).status).toBe(200);

      // Control: B's own token logs B out and leaves A's session signed in.
      const own = await b.post('/logout', {}, { csrf: bToken });
      expect(own.status).toBe(303);
      expect(own.location).toBe('/login');
      expect(await sessionKeys()).toEqual([keyOf(sidA)]);
      expect((await a.get('/tasks')).status).toBe(200);
    },
  );
});

describe('return path (plan 0.3.4)', () => {
  test('an unauthenticated page request returns to that page after login', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);

    const guarded = await client.get('/tasks/new');
    expect(guarded.status).toBe(302);
    expect(guarded.location).toBe('/login?next=%2Ftasks%2Fnew');

    const page = await client.get('/login?next=%2Ftasks%2Fnew');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<input type="hidden" name="next" value="/tasks/new">');

    const res = await client.post('/login', { email, password, next: '/tasks/new' });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks/new');
  });

  test.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/login'])(
    'login with next=%s returns to /tasks',
    async (next) => {
      const email = uniqueEmail();
      const password = newPassword();
      expect((await signUp(newClient(app), email, password)).status).toBe(303);

      const res = await logIn(newClient(app), email, password, next);

      expect(res.status).toBe(303);
      expect(res.location).toBe('/tasks');
    },
  );

  test('sign-up carries the return path on to the login page', async () => {
    const res = await signUp(newClient(app), uniqueEmail(), newPassword(), '/tasks/new');

    expect(res.status).toBe(303);
    expect(res.location).toBe('/login?created=1&next=%2Ftasks%2Fnew');
  });
});

describe('logout and cross-user cases', () => {
  /**
   * Asserts what a logout that presented a `sid` clears, which is what keeps Chrome from showing
   * a signed-in page on Back: every `sid` it sets expires (and it sets one), the client is left
   * with neither `sid` nor the `csrf` nonce, and the response sends `Clear-Site-Data: "cache"`.
   */
  function expectLogoutClears(client: HttpClient, res: HttpResult): void {
    const sids = res.setCookies.map(parseSetCookie).filter((cookie) => cookie.name === 'sid');
    expect(sids.length).toBeGreaterThan(0);
    for (const cleared of sids) {
      // Express computes the clearing Expires from real time, not from the fake clock.
      const expiredByMaxAge = cleared.maxAge !== null && cleared.maxAge <= 0;
      const expiredByDate = cleared.expires !== null && cleared.expires.getTime() < Date.now();
      expect(expiredByMaxAge || expiredByDate).toBe(true);
    }
    // The client reports a cleared cookie as `undefined`; it has no `null` state.
    expect(client.cookie('sid')).toBeUndefined();
    expect(client.cookie('csrf')).toBeUndefined();
    expect(res.headers.get('clear-site-data')).toBe('"cache"');
  }

  /** A `sid` cookie that a request presents while no session is active. */
  interface StaleSid {
    label: string;
    /** Returns the cookie value, URL-encoded as the server would send it. */
    make(): Promise<string>;
  }

  const newToken = (): string => randomBytes(32).toString('base64url');

  const STALE_SIDS: readonly StaleSid[] = [
    {
      label: 'an idle-expired session',
      make: async () => {
        const { client } = await signedInUser();
        clock.advance(IDLE_MS);
        return requireSid(client);
      },
    },
    {
      label: 'a validly signed unknown token',
      make: async () => encodeURIComponent(signCookieValue(newToken(), app.config.sessionSecret)),
    },
    {
      label: 'a bad signature',
      make: async () => encodeURIComponent(signCookieValue(newToken(), 'x'.repeat(32))),
    },
    { label: 'an unsigned value', make: async () => newToken() },
  ];

  test('logout deletes the session, clears sid and sends the user to /login', async () => {
    const { client, userId } = await signedInUser();
    const nonce = client.cookie('csrf');
    expect(nonce).toBeDefined();

    const res = await client.post('/logout', {});

    expect(res.status).toBe(303);
    expect(res.location).toBe('/login');
    expect(await sessionsForUser(pool, userId)).toHaveLength(0);
    expectLogoutClears(client, res);

    const after = await client.get('/tasks');
    expect(after.status).toBe(302);
    expect(after.location).toBe('/login?next=%2Ftasks');
    // The next response issues a fresh nonce, the cookie change Chrome needs to drop the pages.
    expect(client.cookie('csrf')).toEqual(expect.any(String));
    expect(client.cookie('csrf')).not.toBe(nonce);
  });

  test.each(STALE_SIDS)(
    'logout presenting $label clears sid, csrf and the cache and redirects to /login',
    async ({ make }) => {
      const client = newClient(app);
      client.setCookie('sid', await make());
      client.setCookie('csrf', newToken());

      const res = await client.post('/logout', {}, { csrf: false });

      expect(res.status).toBe(303);
      expect(res.location).toBe('/login');
      expect(res.body).not.toContain(CSRF_EXPIRED);
      expectLogoutClears(client, res);
      expect(await countRows(pool, 'sessions')).toBe(0);
    },
  );

  test('logout without a sid cookie redirects to /login and changes nothing', async () => {
    const { client, userId } = await signedInUser();
    const before = await sessionsForUser(pool, userId);
    expect(before).toHaveLength(1);

    // `SameSite=Lax` keeps the user's cookies off a cross-site form post, so the server gets a
    // request with no cookie at all, as from this other client with an empty jar. Its response
    // must not clear `sid`, or the browser would apply that to the user's own cookie.
    const res = await newClient(app).post('/logout', {}, { csrf: false });

    expect(res.status).toBe(303);
    expect(res.location).toBe('/login');
    expect(res.body).not.toContain(CSRF_EXPIRED);
    expect(cookieNamed(res, 'sid')).toBeUndefined();
    expect(res.headers.get('clear-site-data')).toBeNull();
    expect(await sessionsForUser(pool, userId)).toEqual(before);
    expect((await client.get('/tasks')).status).toBe(200);
  });

  test('a signed-in user is redirected away from the sign-up and login pages', async () => {
    const email = uniqueEmail();
    const password = newPassword();
    const client = newClient(app);
    expect((await signUp(client, email, password)).status).toBe(303);
    // Still valid for the anonymous forms after login, because the nonce cookie is unchanged:
    // were the CSRF check to run before the guard, these posts would pass it and write rows.
    const anonToken = await fetchAnonToken(client);
    const login = await client.post('/login', { email, password }, { csrf: anonToken });
    expect(login.status).toBe(303);

    for (const path of ['/signup', '/login']) {
      const res = await client.get(path);
      expect({ path, status: res.status, location: res.location }).toEqual({
        path,
        status: 302,
        location: '/tasks',
      });
    }
    const signUpPost = await client.post(
      '/signup',
      { email: uniqueEmail(), password: newPassword() },
      { csrf: anonToken },
    );
    expect(signUpPost.status).toBe(303);
    expect(signUpPost.location).toBe('/tasks');
    const logInPost = await client.post('/login', { email, password }, { csrf: anonToken });
    expect(logInPost.status).toBe(303);
    expect(logInPost.location).toBe('/tasks');
    expect(cookieNamed(logInPost, 'sid')).toBeUndefined();

    expect(await countRows(pool, 'users')).toBe(1);
    expect(await countRows(pool, 'sessions')).toBe(1);
  });

  test('each login issues a fresh token, and logging in as B never reuses A\'s', async () => {
    const a = { email: uniqueEmail(), password: newPassword() };
    const b = { email: uniqueEmail(), password: newPassword() };
    const setup = newClient(app);
    expect((await signUp(setup, a.email, a.password)).status).toBe(303);
    expect((await signUp(setup, b.email, b.password)).status).toBe(303);
    const aId = await userIdOf(pool, a.email);
    const bId = await userIdOf(pool, b.email);

    const client1 = newClient(app);
    const client2 = newClient(app);
    expect((await logIn(client1, a.email, a.password)).status).toBe(303);
    expect((await logIn(client2, a.email, a.password)).status).toBe(303);
    const sidA1 = requireSid(client1);
    const sidA2 = requireSid(client2);
    expect(sidA1).not.toBe(sidA2);
    expect(await sessionsForUser(pool, aId)).toHaveLength(2);

    // A logs out on client 1, then B logs in on that same client.
    expect((await client1.get('/tasks')).status).toBe(200);
    expect((await client1.post('/logout', {})).status).toBe(303);
    expect((await logIn(client1, b.email, b.password)).status).toBe(303);
    const sidB = requireSid(client1);
    expect(sidB).not.toBe(sidA1);
    expect(sidB).not.toBe(sidA2);

    const ownerOf = async (sid: string): Promise<number[]> => {
      const rows = await sql<{ userId: number }>(
        pool,
        'SELECT user_id AS "userId" FROM sessions WHERE id = $1',
        [sessionIdHash(sid)],
      );
      return rows.map((row) => row.userId);
    };
    expect(await ownerOf(sidB)).toEqual([bId]);
    expect(await ownerOf(sidA1)).toEqual([]);
    expect(await ownerOf(sidA2)).toEqual([aId]);
    const tasksAsB = await client1.get('/tasks');
    expect(tasksAsB.status).toBe(200);
    expect(tasksAsB.body).toContain(`Signed in as ${b.email}`);
    expect(tasksAsB.body).not.toContain(a.email);

    // A's logged-out token, set back on a client, no longer authenticates.
    const replay = newClient(app);
    replay.setCookie('sid', sidA1);
    const res = await replay.get('/tasks');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?next=%2Ftasks');
  });
});

/**
 * Integration tests for server-side sessions against real PostgreSQL 16 (SC3): idle and absolute
 * expiry at their exact boundaries, activity updates under concurrent and out-of-order requests,
 * tampered, unsigned and unknown `sid` cookies, and the login redirect of every protected route.
 *
 * Every case drives the real in-process application with a `FakeClock`, so time moves only when a
 * test sets or advances it. Each request that `loadSession` authenticates counts as activity and
 * slides the idle window, so every boundary is measured from the last request on that session,
 * never from the login.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/session-policy';
import { hashSessionToken } from '../../src/auth/tokens';
import { createSessionsRepo } from '../../src/db/sessions-repo';

import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import { parseSetCookie, rawSessionToken, signCookieValue } from '../helpers/http-client';
import type { HttpClient, HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import {
  createTestPool,
  sessionsForUser,
  sql,
  truncateAll,
  userIdByEmail,
} from '../helpers/test-db';

/** T0, the fake clock's start instant in epoch milliseconds; every session here starts at it. */
const T0 = Date.parse(FAKE_CLOCK_START);

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

/** Name of the session cookie the application sets at login and clears on rejection. */
const SESSION_COOKIE = 'sid';

/** Where a rejected `GET /tasks`, and every unauthenticated `POST`, is sent. */
const TASKS_LOGIN_REDIRECT = '/login?next=%2Ftasks';

/** One stored session row, as the test database reader returns it. */
type SessionRow = Awaited<ReturnType<typeof sessionsForUser>>[number];

/** A user signed up and logged in through the application, with the session it holds. */
interface SignedInUser {
  email: string;
  userId: number;
  /** The raw session token, the value the server hashes into `sessions.id`. */
  token: string;
  /** The `sid` cookie value exactly as the server sent it: signed and URL-encoded. */
  cookie: string;
}

/** A forged `sid` value built from a real session and the application's secret. */
interface BadCookieCase {
  label: string;
  forge(user: SignedInUser, secret: string): string;
}

/** A protected page and the login location an anonymous request for it must receive. */
interface PageCase {
  method: 'GET' | 'HEAD';
  path: string;
  location: string;
}

/** Protected pages with their expected login locations, written out rather than computed. */
const PROTECTED_PAGES: readonly Omit<PageCase, 'method'>[] = [
  { path: '/tasks', location: '/login?next=%2Ftasks' },
  { path: '/tasks/new', location: '/login?next=%2Ftasks%2Fnew' },
  { path: '/tasks/1/edit', location: '/login?next=%2Ftasks%2F1%2Fedit' },
  { path: '/reports', location: '/login?next=%2Freports' },
  { path: '/reports/export', location: '/login?next=%2Freports%2Fexport' },
  { path: '/tasks?status=Done', location: '/login?next=%2Ftasks%3Fstatus%3DDone' },
  {
    path: '/reports?from=2026-10-01&to=2026-10-21',
    location: '/login?next=%2Freports%3Ffrom%3D2026-10-01%26to%3D2026-10-21',
  },
];

const PAGE_CASES: readonly PageCase[] = PROTECTED_PAGES.flatMap((page) => [
  { method: 'GET' as const, ...page },
  { method: 'HEAD' as const, ...page },
]);

/** Every protected form endpoint, each with a plausible body and no CSRF token. */
const PROTECTED_FORMS: readonly { path: string; fields: Record<string, string> }[] = [
  { path: '/tasks/new', fields: { title: 'Unauthenticated', status: 'To do', priority: 'Medium' } },
  { path: '/tasks/1/edit', fields: { title: 'Unauthenticated', status: 'Done', priority: 'High' } },
  { path: '/tasks/1/status', fields: { status: 'Done' } },
  { path: '/tasks/1/delete', fields: { confirm: 'yes' } },
];

/**
 * Returns `rawCookie` with the last character of its signature changed, re-encoded the way
 * Express writes a signed cookie. Decoding first keeps the edit off a percent-escape, so the
 * result is still a well-formed signed value whose signature simply does not verify.
 */
function tamperSignature(rawCookie: string): string {
  const decoded = decodeURIComponent(rawCookie);
  const replacement = decoded.endsWith('A') ? 'B' : 'A';
  return encodeURIComponent(`${decoded.slice(0, -1)}${replacement}`);
}

const BAD_COOKIES: readonly BadCookieCase[] = [
  { label: 'a tampered signature', forge: (user) => tamperSignature(user.cookie) },
  { label: 'an unsigned token', forge: (user) => user.token },
  {
    label: 'an unknown, validly signed token',
    forge: (_user, secret) =>
      encodeURIComponent(signCookieValue(randomBytes(32).toString('base64url'), secret)),
  },
];

/** Asserts the status and `Location` together, so a failure shows both. */
function expectRedirect(res: HttpResult, status: number, location: string): void {
  expect({ status: res.status, location: res.location }).toEqual({ status, location });
}

/**
 * Asserts that `res` clears the session cookie at the path it was set with, and that `client`
 * therefore no longer holds it.
 */
function expectSessionCookieCleared(res: HttpResult, client: HttpClient): void {
  const sid = res.setCookies.map(parseSetCookie).filter((c) => c.name === SESSION_COOKIE);
  expect(sid).toHaveLength(1);
  const [cleared] = sid;
  if (cleared === undefined) {
    throw new Error('expected one Set-Cookie for sid');
  }
  expect(cleared.value).toBe('');
  expect(cleared.path).toBe('/');
  // Max-Age decides when present and Expires otherwise (RFC 6265 §5.3); Express 4 clears with an
  // Expires at the epoch, judged against real time as a browser would.
  const expiresNow =
    cleared.maxAge !== null
      ? cleared.maxAge <= 0
      : cleared.expires !== null && cleared.expires.getTime() <= Date.now();
  expect(expiresNow).toBe(true);
  expect(client.cookie(SESSION_COOKIE)).toBeUndefined();
}

describe('sessions', () => {
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
   * Signs up a unique user and logs in through the application's own forms, so the session is
   * created at the current fake time exactly as a browser's would be.
   */
  async function signUpAndLogIn(client: HttpClient): Promise<SignedInUser> {
    const email = `session-${randomUUID()}@example.com`;
    // The fixed prefix supplies the letter and digit the password policy requires.
    const password = `Session1-${randomBytes(12).toString('hex')}`;

    expect((await client.get('/signup')).status).toBe(200);
    expectRedirect(await client.post('/signup', { email, password }), 303, '/login?created=1');
    expect((await client.get('/login?created=1')).status).toBe(200);
    expectRedirect(await client.post('/login', { email, password }), 303, '/tasks');

    const cookie = client.cookie(SESSION_COOKIE);
    if (cookie === undefined) {
      throw new Error('signUpAndLogIn: login set no sid cookie');
    }
    const userId = await userIdByEmail(pool, email);
    if (userId === null) {
      throw new Error('signUpAndLogIn: the signed-up user is missing');
    }
    return { email, userId, token: rawSessionToken(cookie), cookie };
  }

  /** Reads the user's sessions and returns the only one, failing when there is not exactly one. */
  async function onlySession(userId: number): Promise<SessionRow> {
    const rows = await sessionsForUser(pool, userId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) {
      throw new Error('expected exactly one session row');
    }
    return row;
  }

  /** Counts every session row in the database, whoever owns it. */
  async function sessionCount(): Promise<number> {
    const rows = await sql<{ count: number }>(pool, 'SELECT count(*) AS count FROM sessions');
    return rows[0]?.count ?? 0;
  }

  /** Requests `/tasks` and asserts the expired outcome: redirect, cleared cookie, no row. */
  async function expectExpired(client: HttpClient, userId: number): Promise<void> {
    const res = await client.get('/tasks');
    expectRedirect(res, 302, TASKS_LOGIN_REDIRECT);
    expectSessionCookieCleared(res, client);
    expect(await sessionsForUser(pool, userId)).toEqual([]);
  }

  describe('idle expiry (30 minutes)', () => {
    it('accepts a request after 29:59 without activity and records it', async () => {
      const client = app.client();
      const user = await signUpAndLogIn(client);

      clock.advance(29 * MINUTE_MS + 59_000);
      expect((await client.get('/tasks')).status).toBe(200);
      expect((await onlySession(user.userId)).lastActiveAt).toEqual(clock.now());
    });

    it('redirects after exactly 30:00 without activity, deleting the session', async () => {
      const client = app.client();
      const user = await signUpAndLogIn(client);

      clock.advance(30 * MINUTE_MS);
      await expectExpired(client, user.userId);
    });
  });

  describe('absolute expiry (8 hours)', () => {
    it('keeps a steadily active session until 8 hours of age, then redirects', async () => {
      const client = app.client();
      const user = await signUpAndLogIn(client);

      const statuses: number[] = [];
      for (let request = 0; request < 16; request += 1) {
        clock.advance(29 * MINUTE_MS);
        statuses.push((await client.get('/tasks')).status);
      }
      expect(statuses).toEqual(new Array<number>(16).fill(200));
      expect(clock.now().getTime() - T0).toBe(7 * HOUR_MS + 44 * MINUTE_MS);

      // Idle for 16 minutes, so only the absolute limit is near.
      clock.set(new Date(T0 + 8 * HOUR_MS - 1));
      expect((await client.get('/tasks')).status).toBe(200);
      expect((await onlySession(user.userId)).expiresAt.getTime()).toBe(T0 + 8 * HOUR_MS);

      // Refused although the last activity was 1 ms ago.
      clock.set(new Date(T0 + 8 * HOUR_MS));
      await expectExpired(client, user.userId);
    });
  });

  describe('the exact expires_at boundary', () => {
    it('accepts a request 1 ms before expires_at, slides it, and refuses one at it', async () => {
      const client = app.client();
      const user = await signUpAndLogIn(client);

      const expiresAt = (await onlySession(user.userId)).expiresAt.getTime();
      expect(expiresAt).toBe(T0 + 30 * MINUTE_MS);

      const lastActivity = expiresAt - 1;
      clock.set(new Date(lastActivity));
      expect((await client.get('/tasks')).status).toBe(200);

      const slid = (await onlySession(user.userId)).expiresAt.getTime();
      expect(slid).toBe(Math.min(T0 + SESSION_ABSOLUTE_MS, lastActivity + SESSION_IDLE_MS));
      expect(slid).toBeGreaterThan(expiresAt);

      clock.set(new Date(slid));
      await expectExpired(client, user.userId);
    });
  });

  describe('concurrent and out-of-order activity', () => {
    it('leaves one row stamped with the time of ten concurrent requests', async () => {
      const client = app.client();
      const user = await signUpAndLogIn(client);

      const t = T0 + 10 * MINUTE_MS;
      clock.set(new Date(t));
      const results = await Promise.all(Array.from({ length: 10 }, () => client.get('/tasks')));
      expect(results.map((res) => res.status)).toEqual(new Array<number>(10).fill(200));

      const row = await onlySession(user.userId);
      expect(row.lastActiveAt.getTime()).toBe(t);
      expect(row.expiresAt.getTime()).toBe(Math.min(T0 + SESSION_ABSOLUTE_MS, t + SESSION_IDLE_MS));
    });

    it('moves neither timestamp back when earlier activity arrives after later', async () => {
      const user = await signUpAndLogIn(app.client());
      const repo = createSessionsRepo(pool);
      const idHash = hashSessionToken(user.token);
      const limits = { absoluteMs: SESSION_ABSOLUTE_MS, idleMs: SESSION_IDLE_MS };
      expect((await onlySession(user.userId)).idHash.equals(idHash)).toBe(true);

      const t2 = T0 + 10 * MINUTE_MS;
      const later = await repo.touchIfActive(idHash, new Date(t2), limits);
      expect(later?.lastActiveAt.getTime()).toBe(t2);
      const r2 = await onlySession(user.userId);

      // Still before expires_at, so the session is active and the touch succeeds.
      const t1 = T0 + 5 * MINUTE_MS;
      const earlier = await repo.touchIfActive(idHash, new Date(t1), limits);
      expect(earlier?.lastActiveAt.getTime()).toBe(t2);
      const r1 = await onlySession(user.userId);

      expect(r1.lastActiveAt.getTime()).toBe(t2);
      expect(r1.expiresAt.getTime()).toBe(r2.expiresAt.getTime());
    });

    it('never moves expires_at back across two instances with different clocks', async () => {
      const clientA = app.client();
      const user = await signUpAndLogIn(clientA);

      const t1 = T0 + 5 * MINUTE_MS;
      const t2 = T0 + 10 * MINUTE_MS;
      clock.set(new Date(t1));
      const clockB = new FakeClock(new Date(t2));
      // The same secret, so instance B verifies the cookie instance A signed.
      const appB = await startTestApp({ clock: clockB, sessionSecret: app.config.sessionSecret });
      try {
        const clientB = appB.client();
        clientB.setCookie(SESSION_COOKIE, user.cookie);

        let previousExpiry = (await onlySession(user.userId)).expiresAt.getTime();
        for (let round = 0; round < 4; round += 1) {
          // Alternates which instance's requests are issued first.
          const pair = round % 2 === 0 ? [clientA, clientB] : [clientB, clientA];
          const results = await Promise.all(
            [...pair, ...pair, ...pair].map((client) => client.get('/tasks')),
          );
          expect(results.map((res) => res.status)).toEqual(new Array<number>(6).fill(200));

          const row = await onlySession(user.userId);
          expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(previousExpiry);
          expect(row.lastActiveAt.getTime()).toBe(t2);
          previousExpiry = row.expiresAt.getTime();
        }
        expect(previousExpiry).toBe(Math.min(T0 + SESSION_ABSOLUTE_MS, t2 + SESSION_IDLE_MS));
      } finally {
        await appB.close();
      }
    });
  });

  describe('tampered, unsigned and unknown cookies', () => {
    it.each(BAD_COOKIES)(
      'redirects and clears $label without touching the session',
      async ({ forge }) => {
        const client = app.client();
        const user = await signUpAndLogIn(client);
        const before = await onlySession(user.userId);

        // Any session query that did run for this session would now move last_active_at.
        clock.advance(MINUTE_MS);
        const forged = forge(user, app.config.sessionSecret);
        expect(forged).not.toBe(user.cookie);
        client.setCookie(SESSION_COOKIE, forged);

        const res = await client.get('/tasks');
        expectRedirect(res, 302, TASKS_LOGIN_REDIRECT);
        expectSessionCookieCleared(res, client);
        expect(await onlySession(user.userId)).toEqual(before);
        expect(await sessionCount()).toBe(1);

        client.setCookie(SESSION_COOKIE, user.cookie);
        expect((await client.get('/tasks')).status).toBe(200);
        expect((await onlySession(user.userId)).lastActiveAt).toEqual(clock.now());
      },
    );
  });

  describe('unauthenticated requests to protected routes', () => {
    it.each(PAGE_CASES)(
      '$method $path redirects 302 to the login page, keeping the path',
      async ({ method, path, location }) => {
        const client = app.client();
        const res = method === 'GET' ? await client.get(path) : await client.head(path);
        expectRedirect(res, 302, location);
      },
    );

    // Authentication runs before the CSRF check, so a missing token gives the login redirect
    // rather than 403, and the guard answers before any task lookup could give 404.
    it.each(PROTECTED_FORMS)(
      'POST $path redirects 303 to the login page for the task list',
      async ({ path, fields }) => {
        const res = await app.client().post(path, fields, { csrf: false });
        expectRedirect(res, 303, TASKS_LOGIN_REDIRECT);
      },
    );
  });
});

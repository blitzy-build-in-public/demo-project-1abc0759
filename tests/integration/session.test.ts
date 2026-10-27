/**
 * Integration tests for server-side sessions against real PostgreSQL 16 (SC3): idle and absolute
 * expiry at their exact boundaries, activity updates under concurrent and out-of-order requests,
 * tampered, unsigned and unknown `sid` cookies, and the login redirect of every protected route.
 *
 * Every case drives the real in-process application with a `FakeClock`, so time moves only when a
 * test sets or advances it. Each request that `loadSession` authenticates counts as activity and
 * slides the idle window, so every boundary is measured from the last request on that session,
 * never from the login.
 *
 * The file also checks the cookie-jar client in `tests/helpers/http-client.ts`, which every
 * session case relies on to act as the browser. Those cases drive it against a local `node:http`
 * stand-in for the application that writes raw `Set-Cookie` lines and echoes the `Cookie` header
 * it receives, so the jar is judged by what goes over the wire: path scoping, replacement and
 * clearing (RFC 6265 §5.1.4, §5.3, §5.4), `Max-Age` taking precedence over `Expires`, the
 * one-origin binding, the remembered CSRF page and the cookie-name token rule. A second server
 * stands for a foreign origin and records every request it receives, which must stay none.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { Pool } from 'pg';

import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/session-policy';
import { hashSessionToken } from '../../src/auth/tokens';
import { createSessionsRepo } from '../../src/db/sessions-repo';

import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import {
  HttpClient,
  parseSetCookie,
  rawSessionToken,
  signCookieValue,
} from '../helpers/http-client';
import type { HttpResult } from '../helpers/http-client';
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

/** The echo body for a request that carried no `Cookie` header. */
const NO_COOKIE = '<none>';

/** The `Expires` value Express 4's `res.clearCookie` writes. */
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** An `Expires` value far in the future. */
const FUTURE = 'Wed, 01 Jan 2099 00:00:00 GMT';

/** The CSRF token of `/page`, which serves it HTML-escaped. */
const PAGE_TOKEN = 'tok&1';

/** The CSRF token of `/next-page`. */
const NEXT_TOKEN = 'next-token';

/** Returns a form page whose `_csrf` field holds `escapedToken` as written. */
function formPage(escapedToken: string): string {
  return `<form method="post"><input type="hidden" name="_csrf" value="${escapedToken}"></form>`;
}

/** The HTML pages the application stand-in serves, by path. */
const PAGES: Readonly<Record<string, string>> = {
  '/page': formPage('tok&amp;1'),
  '/next-page': formPage(NEXT_TOKEN),
};

/** The exact message of a request refused for leaving the client's origin. */
const OUTSIDE_ORIGIN = /^HttpClient: request URL is outside the client origin$/;

/** One request the foreign server received. */
interface ForeignHit {
  url: string;
  cookie: string | null;
}

/** Reads a request body as UTF-8. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The application stand-in. Each `set` query parameter becomes one raw `Set-Cookie` line, so a
 * case sets cookies from whichever request path it needs. Then:
 * - a path in {@link PAGES} answers with that HTML page;
 * - `/status/<code>` answers with that status, `Content-Type: text/html` and no content;
 * - any other `POST` answers with the received form body;
 * - anything else answers with the received `Cookie` header, or {@link NO_COOKIE}.
 */
async function handleApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const lines = url.searchParams.getAll('set');
  if (lines.length > 0) {
    res.setHeader('set-cookie', lines);
  }
  const body = await readBody(req);
  const page = PAGES[url.pathname];
  const status = /^\/status\/(\d{3})$/.exec(url.pathname);
  if (page !== undefined) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  } else if (status !== null) {
    res.writeHead(Number(status[1]), { 'content-type': 'text/html; charset=utf-8' });
    res.end();
  } else if (req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  } else {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.headers.cookie ?? NO_COOKIE);
  }
}

/** Starts `server` on an ephemeral loopback port and returns its origin. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server has no TCP address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** Stops `server`, dropping the keep-alive connections `fetch` leaves open. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Returns `path` with one `set` query parameter per raw `Set-Cookie` line. */
function setting(path: string, ...lines: string[]): string {
  const query = new URLSearchParams(lines.map((line): [string, string] => ['set', line]));
  return `${path}?${query.toString()}`;
}

/** Returns the `Cookie` header `client` sends to `path`, or {@link NO_COOKIE}. */
async function sentCookies(client: HttpClient, path: string): Promise<string> {
  return (await client.get(path)).body;
}

describe('HttpClient, the cookie-jar client every session case relies on', () => {
  /** Every request the foreign server has received. */
  const foreignHits: ForeignHit[] = [];

  /** The application stand-in, which {@link handleApp} answers for. */
  let jarServer: Server;
  /** The foreign origin, which only records what reaches it. */
  let foreignServer: Server;
  let jarBase = '';
  let foreignBase = '';

  /** Returns a client holding `sid=A` at `/` and then `sid=B` at `/tasks`. */
  async function twoSids(): Promise<HttpClient> {
    const client = new HttpClient(jarBase);
    await client.get(setting('/', 'sid=A; Path=/; HttpOnly'));
    await client.get(setting('/', 'sid=B; Path=/tasks; HttpOnly'));
    return client;
  }

  beforeAll(async () => {
    jarServer = createServer((req, res) => {
      // A failure drops the connection, so the request under test rejects instead of hanging.
      handleApp(req, res).catch(() => res.destroy());
    });
    foreignServer = createServer((req, res) => {
      foreignHits.push({ url: req.url ?? '', cookie: req.headers.cookie ?? null });
      req.resume();
      req.on('end', () => res.end('collected'));
    });
    [jarBase, foreignBase] = await Promise.all([listen(jarServer), listen(foreignServer)]);
  });

  afterAll(async () => {
    await Promise.all([close(jarServer), close(foreignServer)]);
  });

  describe('HttpClient cookie paths (RFC 6265 §5.1.4, §5.3, §5.4)', () => {
    it.each([
      ['/x', 'sid=A'],
      ['/tasks', 'sid=B; sid=A'],
      ['/tasks/x', 'sid=B; sid=A'],
      ['/tasksx', 'sid=A'],
    ])('keeps sid at / and at /tasks apart: %s is sent %p', async (path, expected) => {
      const client = await twoSids();

      expect(await sentCookies(client, path)).toBe(expected);
      expect(client.cookie('sid')).toBe('A');
    });

    it('clearing sid at Path=/tasks keeps the sid at /', async () => {
      const client = await twoSids();
      await client.get(setting('/tasks/x', `sid=; Path=/tasks; Expires=${EPOCH}; HttpOnly`));

      expect(client.cookie('sid')).toBe('A');
      expect(await sentCookies(client, '/tasks/x')).toBe('sid=A');
    });

    it(
      'clearing sid at Path=/ as res.clearCookie writes it removes only the sid at /',
      async () => {
        const client = await twoSids();
        await client.get(
          setting('/logout', `sid=; Path=/; Expires=${EPOCH}; HttpOnly; SameSite=Lax`),
        );

        expect(client.cookie('sid')).toBeUndefined();
        expect(await sentCookies(client, '/x')).toBe(NO_COOKIE);
        expect(await sentCookies(client, '/tasks/x')).toBe('sid=B');
      },
    );

    it.each(['np=1', 'np=1; Path=', 'np=1; Path=a/b'])(
      'stores %p, received from /a/b/set, at the default path /a/b',
      async (line) => {
        const client = new HttpClient(jarBase);
        await client.get(setting('/a/b/set', line));

        expect(await sentCookies(client, '/a/b/x')).toBe('np=1');
        expect(await sentCookies(client, '/a/b')).toBe('np=1');
        expect(await sentCookies(client, '/a/bc')).toBe(NO_COOKIE);
        expect(await sentCookies(client, '/a/x')).toBe(NO_COOKIE);
        expect(await sentCookies(client, '/')).toBe(NO_COOKIE);
        expect(client.cookie('np')).toBeUndefined();
      },
    );

    it('stores a cookie without Path received from a one-segment path at /', async () => {
      const client = new HttpClient(jarBase);
      await client.get(setting('/login', 'np=1'));

      expect(client.cookie('np')).toBe('1');
      expect(await sentCookies(client, '/tasks/x')).toBe('np=1');
    });

    it('stores and sends a Secure cookie over plain HTTP', async () => {
      const client = new HttpClient(jarBase);
      await client.get(
        setting('/', 'sec=S; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax'),
      );

      expect(client.cookie('sec')).toBe('S');
      expect(await sentCookies(client, '/x')).toBe('sec=S');
    });

    it('setCookie replaces the cookie at / and leaves the one at /tasks', async () => {
      const client = await twoSids();
      client.setCookie('sid', 'T');

      expect(client.cookie('sid')).toBe('T');
      expect(await sentCookies(client, '/x')).toBe('sid=T');
      expect(await sentCookies(client, '/tasks/x')).toBe('sid=B; sid=T');
    });

    it('orders equal paths by creation: replaced cookies stay, re-added ones go last', async () => {
      const client = new HttpClient(jarBase);
      await client.get(setting('/', 'a=1; Path=/', 'b=1; Path=/'));
      await client.get(setting('/', 'a=2; Path=/'));

      expect(await sentCookies(client, '/x')).toBe('a=2; b=1');

      await client.get(setting('/', `a=; Path=/; Expires=${EPOCH}`));
      await client.get(setting('/', 'a=3; Path=/'));

      expect(await sentCookies(client, '/x')).toBe('b=1; a=3');
    });

    it.each(['cookie', 'Cookie', 'COOKIE'])('a caller %p header replaces the jar', async (name) => {
      const client = await twoSids();

      expect((await client.get('/tasks/x', { [name]: 'x=1' })).body).toBe('x=1');
    });

    it('clearCookies empties every path', async () => {
      const client = await twoSids();
      client.clearCookies();

      expect(await sentCookies(client, '/tasks/x')).toBe(NO_COOKIE);
    });
  });

  describe('HttpClient origin binding', () => {
    /** Sends one request that leaves the client's origin. */
    type Send = (client: HttpClient) => Promise<HttpResult>;

    it.each<[string, Send]>([
      ['get with an absolute foreign URL', (c) => c.get(`${foreignBase}/collect`)],
      [
        'get with a protocol-relative foreign URL',
        (c) => c.get(`${foreignBase.replace(/^http:/, '')}/collect`),
      ],
      [
        'post with credentials to a foreign URL',
        (c) =>
          c.post(`${foreignBase}/collect`, { email: 'u@example.test', password: 'Secret12345' }),
      ],
      ['head to a foreign URL', (c) => c.head(`${foreignBase}/collect`)],
      ['postRaw to a foreign URL', (c) => c.postRaw(`${foreignBase}/collect`, 'a=b', 'text/plain')],
      ['get with a data: URL', (c) => c.get('data:text/plain,hi')],
      ['get with a blob: URL wrapping its own origin', (c) => c.get(`blob:${jarBase}/x`)],
    ])('rejects %s before sending anything', async (_label, send) => {
      const client = new HttpClient(jarBase);
      await client.get(setting('/page', 'sid=A; Path=/'));

      await expect(send(client)).rejects.toThrow(OUTSIDE_ORIGIN);
      expect(foreignHits).toEqual([]);
    });

    it('allows an absolute URL on its own origin and sends the jar with it', async () => {
      const client = new HttpClient(jarBase);
      await client.get(setting('/', 'sid=A; Path=/'));

      expect(await sentCookies(client, `${jarBase}/x`)).toBe('sid=A');
    });

    it.each(['file:///tmp/', 'data:text/plain,hi', 'ftp://127.0.0.1/'])(
      'refuses the non-HTTP base URL %p',
      (url) => {
        expect(() => new HttpClient(url)).toThrow(
          /^HttpClient: base URL must use http: or https:$/,
        );
      },
    );

    it('refuses a relative base URL', () => {
      // Node's URL throws its own realm's TypeError, which is not Jest's global, so match the text.
      expect(() => new HttpClient('/tasks')).toThrow(/^Invalid URL$/);
    });
  });

  describe('HttpClient remembered CSRF page', () => {
    /** Receives one response that carries `Content-Type: text/html` but no content. */
    type Receive = (client: HttpClient) => Promise<HttpResult>;

    it.each<[string, Receive]>([
      ['a HEAD response', (c) => c.head('/page')],
      ['a 204 response', (c) => c.get('/status/204')],
      ['a 205 response', (c) => c.get('/status/205')],
      ['a 304 response', (c) => c.get('/status/304')],
    ])('keeps the last page and its token across %s', async (_label, receive) => {
      const client = new HttpClient(jarBase);
      await client.get('/page');
      const empty = await receive(client);

      expect(empty.headers.get('content-type')).toMatch(/^text\/html/);
      expect(empty.body).toBe('');
      expect(client.csrfToken()).toBe(PAGE_TOKEN);
      const posted = new URLSearchParams((await client.post('/form', { a: '1' })).body);
      expect(posted.get('_csrf')).toBe(PAGE_TOKEN);
    });

    it('replaces the remembered page with the next HTML page only', async () => {
      const client = new HttpClient(jarBase);
      await client.get('/page');
      await client.get('/x');

      expect(client.csrfToken()).toBe(PAGE_TOKEN);

      await client.get('/next-page');

      expect(client.csrfToken()).toBe(NEXT_TOKEN);
    });
  });

  describe('HttpClient Max-Age and Expires (RFC 6265 §5.2.1, §5.2.2, §5.3 step 3)', () => {
    it.each<[string, string, string | undefined]>([
      [
        'Max-Age=28800 with an epoch Expires keeps it',
        `sid=A; Max-Age=28800; Expires=${EPOCH}`,
        'A',
      ],
      [
        'Max-Age=0 with a future Expires removes it',
        `sid=; Max-Age=0; Expires=${FUTURE}`,
        undefined,
      ],
      ['a negative Max-Age removes it', 'sid=; Max-Age=-1', undefined],
      ['an epoch Expires alone removes it', `sid=; Expires=${EPOCH}`, undefined],
      [
        'an invalid Max-Age after a valid one leaves the valid one deciding',
        `sid=A; Max-Age=28800; Max-Age=x; Expires=${EPOCH}`,
        'A',
      ],
      [
        'an invalid Expires after an epoch one leaves the epoch deciding',
        `sid=A; Expires=${EPOCH}; Expires=never`,
        undefined,
      ],
    ])('%s', async (_label, line, expected) => {
      const client = new HttpClient(jarBase);
      client.setCookie('sid', 'OLD');
      await client.get(setting('/', `${line}; Path=/`));

      expect(client.cookie('sid')).toBe(expected);
      expect(await sentCookies(client, '/x')).toBe(
        expected === undefined ? NO_COOKIE : `sid=${expected}`,
      );
    });

    it.each<[string, number | null, number | null]>([
      ['sid=A; Max-Age=28800; Max-Age=x', 28800, null],
      ['sid=A; Max-Age=10; Max-Age=20', 20, null],
      ['sid=A; Max-Age=', null, null],
      [`sid=A; Expires=${EPOCH}; Expires=never`, null, 0],
    ])('parseSetCookie(%p) keeps the last valid Max-Age and Expires', (line, maxAge, expiresAt) => {
      const parsed = parseSetCookie(line);

      expect(parsed.maxAge).toBe(maxAge);
      expect(parsed.expires?.getTime() ?? null).toBe(expiresAt);
    });
  });

  describe('HttpClient.setCookie names (RFC 6265 §4.1.1)', () => {
    it.each([
      'bad/name',
      'a:b',
      '(x)',
      '[x]',
      '{x}',
      '"q"',
      'back\\slash',
      'caf\u00e9',
      'a?b',
      'a@b',
      '<x>',
      'a b',
      '',
      'a=b',
      'a;b',
      'a,b',
      '\u0001',
      'sid\n',
    ])('rejects the non-token name %p', (name) => {
      const client = new HttpClient(jarBase);

      expect(() => client.setCookie(name, 'x')).toThrow(/^setCookie: invalid cookie name$/);
      expect(client.cookie(name)).toBeUndefined();
    });

    it.each(['sid', 'csrf', "a!#$%&'*+-.^_`|~09AZaz"])(
      'accepts the token %p and sends it',
      async (name) => {
        const client = new HttpClient(jarBase);
        client.setCookie(name, 'x');

        expect(client.cookie(name)).toBe('x');
        expect(await sentCookies(client, '/x')).toBe(`${name}=x`);
      },
    );

    it('sends an already URL-encoded value verbatim', async () => {
      const client = new HttpClient(jarBase);
      const value = encodeURIComponent(signCookieValue('token', 'x'.repeat(32)));
      client.setCookie('sid', value);

      expect(client.cookie('sid')).toBe(value);
      expect(await sentCookies(client, '/x')).toBe(`sid=${value}`);
    });
  });
});

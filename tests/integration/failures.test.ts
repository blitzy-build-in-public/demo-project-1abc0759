/**
 * Integration tests for the failure responses and the scheduled purge's failure policy (plan
 * 0.5.4, 0.5.5, 0.3.5 and 0.9.2), driven over real HTTP against real PostgreSQL 16.
 *
 * - 503 "Service temporarily unavailable" while the database is unreachable, logged once as
 *   `database unavailable` with the method and the path but never the query string, after which
 *   both processes keep serving.
 * - 404 "Page not found.", 400 and 413 "Bad request." and 500 "Something went wrong.", none of
 *   them carrying a stack frame, SQL text or driver detail, and no malformed request changing data.
 * - The purge job: a failed run resolves and logs `purge failed`, the same job's next run against
 *   a reachable database purges and logs its counts, and a run never overlaps another.
 *
 * The unreachable instance points at port 1 on the loopback interface, which refuses at once
 * (`ECONNREFUSED`), so no case waits on the pool's 5-second connection timeout.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { runInThisContext } from 'node:vm';

import type { Pool } from 'pg';

import { createAuthService } from '../../src/auth/auth-service';
import type { AuthService, PurgeResult } from '../../src/auth/auth-service';
import { createDataAccess } from '../../src/db/data-access';
import { createPool } from '../../src/db/pool';
import { createSessionsRepo } from '../../src/db/sessions-repo';
import { createPurgeJob } from '../../src/purge-job';
import type { PurgeJob } from '../../src/purge-job';
import type { ReportService } from '../../src/reports/report-service';

import { CaptureLogger } from '../helpers/capture-logger';
import type { CapturedEntry } from '../helpers/capture-logger';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import type { HttpClient, HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import {
  countRows,
  createTestPool,
  insertLoginFailures,
  insertUser,
  loginAttemptRows,
  sessionsForUser,
  truncateAll,
} from '../helpers/test-db';

/**
 * A database that cannot be reached. Its name ends in `_test` because `startTestApp` applies the
 * test-database guard to every URL, and port 1 refuses the connection immediately.
 */
const UNREACHABLE = 'postgres://tasktracker:x@127.0.0.1:1/unreachable_test';

/** The database name inside {@link UNREACHABLE}; no failure page may reveal it. */
const UNREACHABLE_DB_NAME = 'unreachable_test';

/** A password that meets the sign-up policy, used by every account in this file. */
const PASSWORD = 'Failure-test-passw0rd';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Interval handed to every purge job here; no test starts the timer, so it never elapses. */
const PURGE_INTERVAL_MS = 60_000;

/** The lockout key of the login failures seeded for the purge. */
const PURGE_EMAIL = 'purge@example.com';

/** Task fields that `parseTaskForm` accepts, so only the malformation under test can block them. */
const VALID_TASK_FIELDS: Readonly<Record<string, string>> = {
  title: 'Well-formed task',
  description: '',
  status: 'To do',
  priority: 'Medium',
  dueDate: '',
};

/**
 * Fragments whose presence in a body would reveal server internals: a stack frame, SQL text and a
 * driver error code. The SQL keywords keep their case and trailing or surrounding space, because
 * the pages' HTML legitimately contains a lower-case `<select>`.
 */
const LEAK_FRAGMENTS: readonly string[] = [
  '    at ',
  'SELECT ',
  ' FROM ',
  'INSERT ',
  'UPDATE ',
  'ECONNREFUSED',
];

/**
 * The host process. Jest gives each test file its own copy of `process`, and listeners added to
 * that copy never receive the real process's events, so an `unhandledRejection` spy on it could
 * never fire. `runInThisContext` evaluates in Node's main context, whose `process` is the real one.
 */
const hostProcess = runInThisContext('process') as NodeJS.Process;

/**
 * Asserts that a failure body reveals nothing of the server's internals: no fragment of
 * {@link LEAK_FRAGMENTS} and none of `markers`, the values a case injected or sent.
 */
function assertNoLeak(body: string, markers: readonly string[] = []): void {
  for (const fragment of [...LEAK_FRAGMENTS, ...markers]) {
    expect(body).not.toContain(fragment);
  }
}

/** Asserts a fixed-message HTML failure page with `status` that leaks nothing. */
function expectFailurePage(
  res: HttpResult,
  status: number,
  message: string,
  markers: readonly string[] = [],
): void {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  expect(res.body).toContain(message);
  assertNoLeak(res.body, markers);
}

/** The entries a logger recorded at `error` level. */
function errorEntries(logger: CaptureLogger): CapturedEntry[] {
  return logger.entries().filter((entry) => entry.level === 'error');
}

/** URL-encodes `fields` as a form body, in insertion order. */
function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

/**
 * Signs up `email` on `app` through the real forms, then logs in, and returns the client holding
 * the signed `sid` cookie.
 */
async function signUpAndLogIn(app: TestApp, email: string): Promise<HttpClient> {
  const client = app.client();
  expect((await client.get('/signup')).status).toBe(200);
  const signUp = await client.post('/signup', { email, password: PASSWORD });
  expect(signUp.status).toBe(303);
  expect((await client.get('/login')).status).toBe(200);
  const logIn = await client.post('/login', { email, password: PASSWORD });
  expect(logIn.status).toBe(303);
  return client;
}

/** The raw signed `sid` cookie value a client holds; throws when it holds none. */
function sessionCookie(client: HttpClient): string {
  const sid = client.cookie('sid');
  if (sid === undefined) {
    throw new Error('the client holds no sid cookie');
  }
  return sid;
}

/** Fetches the task form and returns its session-bound CSRF token. */
async function taskFormToken(client: HttpClient): Promise<string> {
  expect((await client.get('/tasks/new')).status).toBe(200);
  const token = client.csrfToken();
  if (token === null) {
    throw new Error('the task form carries no CSRF token');
  }
  return token;
}

describe('failure responses and the purge failure policy', () => {
  const clock = new FakeClock();
  const healthyLog = new CaptureLogger();
  const downLog = new CaptureLogger();
  // One secret for both instances, so a `sid` cookie issued by the healthy instance verifies on
  // the unreachable one and the request reaches the database there.
  const sessionSecret = randomBytes(32).toString('hex');

  let pool: Pool;
  let healthy: TestApp;
  let down: TestApp;
  // Registered as each resource opens, so a setup that fails part-way still closes what it opened.
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    pool = createTestPool();
    cleanups.push(() => pool.end());
    healthy = await startTestApp({ clock, logger: healthyLog, sessionSecret });
    cleanups.push(() => healthy.close());
    down = await startTestApp({ clock, logger: downLog, sessionSecret, databaseUrl: UNREACHABLE });
    cleanups.push(() => down.close());
  });

  afterAll(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  });

  beforeEach(async () => {
    await truncateAll(pool);
    clock.set(FAKE_CLOCK_START);
    healthyLog.clear();
    downLog.clear();
  });

  describe('database unavailable (503)', () => {
    it('answers an anonymous POST /login with 503 and logs it once with its path', async () => {
      const email = 'anonymous@example.com';
      const client = down.client();
      // No `sid` cookie, so the page needs no database and carries the anonymous CSRF token.
      expect((await client.get('/login')).status).toBe(200);

      const res = await client.post('/login', { email, password: PASSWORD });

      expectFailurePage(res, 503, 'Service temporarily unavailable', [UNREACHABLE_DB_NAME, email]);
      const logged = downLog.byMsg('database unavailable');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: 'error',
        method: 'POST',
        path: '/login',
        err: { name: 'DatabaseUnavailableError' },
      });
    });

    it('answers a signed-in GET with 503 and logs the path without its query string', async () => {
      const healthyClient = await signUpAndLogIn(healthy, 'signed-in@example.com');
      const sid = sessionCookie(healthyClient);
      const client = down.client();
      client.setCookie('sid', sid);

      const res = await client.get('/tasks?status=Done');

      // A cookie that failed to verify would make the request anonymous and redirect it to the
      // login page, so the 503 shows that the session lookup itself reached the database.
      expectFailurePage(res, 503, 'Service temporarily unavailable', [UNREACHABLE_DB_NAME]);
      const logged = downLog.byMsg('database unavailable');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ level: 'error', method: 'GET', path: '/tasks' });
      expect(downLog.text()).not.toContain('?status');
      expect(downLog.text()).not.toContain('status=Done');
      // The session may still be valid once the database is back, so the cookie is kept.
      expect(client.cookie('sid')).toBe(sid);
    });

    it('keeps both instances serving after a 503', async () => {
      const anonymous = down.client();
      expect((await anonymous.get('/login')).status).toBe(200);
      const failed = await anonymous.post('/login', { email: 'x@example.com', password: PASSWORD });
      expect(failed.status).toBe(503);

      expect((await down.client().get('/login')).status).toBe(200);
      const user = await signUpAndLogIn(healthy, 'still-served@example.com');
      expect((await user.get('/tasks')).status).toBe(200);
    });
  });

  describe('unknown routes (404)', () => {
    const UNKNOWN_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[] = [
      { method: 'GET', path: '/no-such-page' },
      // A bare form POST: the 404 handler runs after the routers, so no guard or CSRF check
      // claims a path no route declares.
      { method: 'POST', path: '/no-such-page' },
      { method: 'GET', path: '/static/missing.js' },
    ];

    it.each(UNKNOWN_ROUTES)(
      'answers $method $path with 404 "Page not found." and logs nothing',
      async ({ method, path }) => {
        const client = healthy.client();

        const res = method === 'GET' ? await client.get(path) : await client.post(path, {});

        expectFailurePage(res, 404, 'Page not found.');
        expect(errorEntries(healthyLog)).toEqual([]);
      },
    );
  });

  describe('malformed requests (400 and 413)', () => {
    interface MalformedCase {
      name: string;
      status: 400 | 413;
      /** Sends the malformed request with a valid session and CSRF token. */
      send(client: HttpClient, csrf: string): Promise<HttpResult>;
    }

    // Every state-changing case carries a valid session-bound token and fields that would
    // otherwise be accepted, so the malformation alone is what keeps the write from happening.
    const MALFORMED_CASES: readonly MalformedCase[] = [
      {
        name: 'a non-numeric task id on GET /tasks/abc/edit',
        status: 400,
        send: (client) => client.get('/tasks/abc/edit'),
      },
      {
        name: 'a non-numeric task id on POST /tasks/abc/edit',
        status: 400,
        send: (client, csrf) => client.post('/tasks/abc/edit', VALID_TASK_FIELDS, { csrf }),
      },
      {
        // body-parser refuses the charset with 415, which the error handler answers as 400.
        name: 'a form body in an unsupported charset',
        status: 400,
        send: (client, csrf) =>
          client.postRaw(
            '/tasks/new',
            formBody({ ...VALID_TASK_FIELDS, title: 'x', _csrf: csrf }),
            'application/x-www-form-urlencoded; charset=latin1',
          ),
      },
      {
        // Over the 100 kb urlencoded limit: 413 with the same "Bad request." page.
        name: 'a form body over the 100 kb limit',
        status: 413,
        send: (client, csrf) =>
          client.postRaw(
            '/tasks/new',
            formBody({ ...VALID_TASK_FIELDS, title: 'a'.repeat(110_000), _csrf: csrf }),
            'application/x-www-form-urlencoded',
          ),
      },
    ];

    it.each(MALFORMED_CASES)(
      'answers $name with $status "Bad request." and changes no data',
      async ({ status, send }) => {
        const client = await signUpAndLogIn(healthy, 'malformed@example.com');
        const csrf = await taskFormToken(client);
        const before = await countRows(pool, 'tasks');

        const res = await send(client, csrf);

        expectFailurePage(res, status, 'Bad request.');
        expect(await countRows(pool, 'tasks')).toBe(before);
        expect(errorEntries(healthyLog)).toEqual([]);

        // Control: the same session and token do write a well-formed task, so the refusal above
        // came from the malformation and not from an invalid session or token.
        const created = await client.post('/tasks/new', VALID_TASK_FIELDS, { csrf });
        expect(created.status).toBe(303);
        expect(await countRows(pool, 'tasks')).toBe(before + 1);
      },
    );
  });

  describe('unexpected error (500)', () => {
    it('answers 500 "Something went wrong." without the error text and logs it', async () => {
      const marker = `marker-${randomUUID()}`;
      // The message imitates a driver error quoting SQL, the worst case for leakage.
      const boom = (): never => {
        throw new Error(`SELECT secret FROM tasks WHERE x = '${marker}'`);
      };
      const throwingReports: ReportService = {
        today: () => '2026-10-21',
        summary: async () => boom(),
        completions: async () => boom(),
        exportCsv: async () => boom(),
      };
      const brokenLog = new CaptureLogger();
      const broken = await startTestApp({
        clock,
        logger: brokenLog,
        overrides: { reports: throwingReports },
      });
      try {
        const client = await signUpAndLogIn(broken, 'broken-reports@example.com');

        const res = await client.get('/reports');

        expectFailurePage(res, 500, 'Something went wrong.', [marker]);
        const logged = brokenLog.byMsg('unexpected error');
        expect(logged).toHaveLength(1);
        // The detail the page withholds is kept in the server-side log.
        expect(logged[0]).toMatchObject({
          level: 'error',
          method: 'GET',
          path: '/reports',
          err: { name: 'Error', message: expect.stringContaining(marker) },
        });
      } finally {
        await broken.close();
      }
    });
  });

  describe('the scheduled purge', () => {
    const purgeLog = new CaptureLogger();
    let downPool: Pool;
    let downAuth: AuthService;
    /** Where the delegating job's purges go; each test starts against the unreachable database. */
    let target: AuthService;

    beforeAll(() => {
      downPool = createPool(UNREACHABLE, purgeLog);
      cleanups.push(() => downPool.end());
      downAuth = createAuthService({ dal: createDataAccess(downPool), clock });
    });

    beforeEach(() => {
      target = downAuth;
      purgeLog.clear();
    });

    /** A job whose purges go to {@link target}. Its timer is never started. */
    function delegatingJob(): PurgeJob {
      return createPurgeJob({
        auth: { purgeExpired: () => target.purgeExpired() },
        logger: purgeLog,
        intervalMs: PURGE_INTERVAL_MS,
      });
    }

    it('resolves a failed run without an unhandled rejection and logs "purge failed"', async () => {
      const job = delegatingJob();
      // Registered on the host process, not on Jest's copy of `process`, so it would observe a
      // real unhandled rejection.
      const spy = jest.fn<void, [unknown, Promise<unknown>]>();
      hostProcess.on('unhandledRejection', spy);
      try {
        await expect(job.runOnce()).resolves.toBeUndefined();
        // Node reports unhandled rejections once the microtask queue drains; one macrotask later
        // any would have reached the spy.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        hostProcess.off('unhandledRejection', spy);
      }

      const failed = purgeLog.byMsg('purge failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        level: 'error',
        err: { name: 'DatabaseUnavailableError' },
      });
      expect(purgeLog.byMsg('purge completed')).toEqual([]);
    });

    it("purges and logs the counts on the same job's next run, once reachable", async () => {
      const job = delegatingJob();
      await job.runOnce();
      expect(purgeLog.byMsg('purge failed')).toHaveLength(1);

      const now = clock.now().getTime();
      const at = (offsetMs: number): Date => new Date(now + offsetMs);
      const userId = await insertUser(pool, { email: PURGE_EMAIL, createdAt: at(-10 * HOUR_MS) });
      const sessions = createSessionsRepo(pool);
      // Two sessions that expired idle half an hour after they were created, nine hours ago.
      for (let i = 0; i < 2; i += 1) {
        await sessions.insert({
          idHash: randomBytes(32),
          userId,
          createdAt: at(-9 * HOUR_MS),
          lastActiveAt: at(-9 * HOUR_MS),
          expiresAt: at(-8.5 * HOUR_MS),
        });
      }
      const activeIdHash = randomBytes(32);
      await sessions.insert({
        idHash: activeIdHash,
        userId,
        createdAt: at(-10 * MINUTE_MS),
        lastActiveAt: at(-5 * MINUTE_MS),
        expiresAt: at(25 * MINUTE_MS),
      });
      // Two failures past the 24-hour retention and one well inside it.
      await insertLoginFailures(pool, PURGE_EMAIL, [
        at(-25 * HOUR_MS),
        at(-25 * HOUR_MS),
        at(-HOUR_MS),
      ]);

      target = healthy.auth;
      await expect(job.runOnce()).resolves.toBeUndefined();

      const completed = purgeLog.byMsg('purge completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ level: 'info', sessions: 2, loginAttempts: 2 });
      const remaining = await sessionsForUser(pool, userId);
      expect(remaining.map((session) => session.idHash)).toEqual([activeIdHash]);
      const attempts = await loginAttemptRows(pool, PURGE_EMAIL);
      expect(attempts.map((attempt) => attempt.failedAt)).toEqual([at(-HOUR_MS)]);
    });

    it('skips a run requested while another is in progress, so runs never overlap', async () => {
      let finishPurge: (result: PurgeResult) => void = () => {
        throw new Error('purgeExpired was not called');
      };
      const purgeExpired = jest.fn(
        (): Promise<PurgeResult> =>
          new Promise<PurgeResult>((resolve) => {
            finishPurge = resolve;
          }),
      );
      const job = createPurgeJob({
        auth: { purgeExpired },
        logger: purgeLog,
        intervalMs: PURGE_INTERVAL_MS,
      });

      const first = job.runOnce();
      const second = job.runOnce();
      // Each runOnce reaches its purge call synchronously, so an overlapping run would show here.
      expect(purgeExpired).toHaveBeenCalledTimes(1);

      // The skipped run settles while the first is still waiting on its purge.
      await expect(second).resolves.toBeUndefined();
      finishPurge({ sessions: 0, loginAttempts: 0 });
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(purgeExpired).toHaveBeenCalledTimes(1);
      expect(purgeLog.byMsg('purge completed')).toHaveLength(1);
    });
  });
});

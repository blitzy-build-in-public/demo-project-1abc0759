/**
 * Integration tests for the failure responses and the scheduled purge's failure policy (plan
 * 0.5.4, 0.5.5, 0.3.5 and 0.9.2), driven over real HTTP against real PostgreSQL 16.
 *
 * - 503 "Service temporarily unavailable" while the database is unreachable, logged once as
 *   `database unavailable` with the method and the path but never the query string, after which
 *   both processes keep serving.
 * - 404 "Page not found.", 400 and 413 "Bad request." and 500 "Something went wrong.", none of
 *   them carrying a stack frame, SQL text or driver detail, and no malformed request changing data.
 *   A logger that throws changes no response: the 500 and 503 pages are still sent, a response
 *   whose headers were already sent is still cut off, and nothing is printed to the console.
 * - The purge job: a failed run resolves and logs `purge failed`, the same job's next run against
 *   a reachable database purges and logs its counts, and a run never overlaps another.
 * - The server's start-up and shutdown, running `main()` from `src/server.ts` in this process:
 *   a failed authentication of an email-shaped database role logs `migration failed` once with
 *   the role and password redacted and exits 1 without listening; a log write that throws at
 *   start-up still releases the port, the purge job, the signal handlers and the pool and exits
 *   1, and one that throws during a shutdown still closes everything and exits 0 exactly once,
 *   neither leaving an unhandled rejection. A `SIGTERM` while a connection has sent no byte,
 *   partial headers or a partial body destroys it and exits 0 at once; a request received in
 *   full before the signal is still answered in full; a response already ended but still queued
 *   behind a reader that has paused is delivered in full before its connection closes; and a
 *   repeat of the same signal during a drain that cannot finish exits 1 at once, while the other
 *   signal is ignored.
 *
 * The unreachable instance points at port 1 on the loopback interface, which refuses at once
 * (`ECONNREFUSED`), so no case waits on the pool's 5-second connection timeout.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { runInThisContext } from 'node:vm';

import express from 'express';
import type { Pool } from 'pg';

import { createAuthService } from '../../src/auth/auth-service';
import type { AuthService, PurgeResult } from '../../src/auth/auth-service';
import { createDataAccess } from '../../src/db/data-access';
import { createPool } from '../../src/db/pool';
import * as poolModule from '../../src/db/pool';
import { createSessionsRepo } from '../../src/db/sessions-repo';
import { createPurgeJob } from '../../src/purge-job';
import type { PurgeJob } from '../../src/purge-job';
import * as purgeJobModule from '../../src/purge-job';
import type { ReportService } from '../../src/reports/report-service';
import { main as startServer } from '../../src/server';
import { DatabaseUnavailableError } from '../../src/shared/errors';
import type { LogFields } from '../../src/shared/logger';
import { createErrorHandler } from '../../src/web/middleware/error-handler';

import { CaptureLogger } from '../helpers/capture-logger';
import type { CapturedEntry } from '../helpers/capture-logger';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import { HttpClient } from '../helpers/http-client';
import type { HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import {
  assertTestDatabaseUrl,
  countRows,
  createTestPool,
  insertLoginFailures,
  insertTask,
  insertUser,
  loginAttemptRows,
  sessionsForUser,
  sql,
  truncateAll,
  userIdByEmail,
} from '../helpers/test-db';

/**
 * A database that cannot be reached. Its name ends in `_test` because `startTestApp` applies the
 * test-database guard to every URL, and port 1 refuses the connection immediately.
 */
const UNREACHABLE = 'postgres://tasktracker:x@127.0.0.1:1/unreachable_test';

/** The database name inside {@link UNREACHABLE}; no failure page may reveal it. */
const UNREACHABLE_DB_NAME = 'unreachable_test';

/**
 * The password of every account in this file, generated once per run so no fixed secret is
 * committed. The `Failure1-` prefix supplies the letter and digit the sign-up policy requires,
 * and the 24 hex characters bring it to 33 ASCII characters, within the policy's minimum of 10
 * characters and maximum of 72 bytes.
 */
const PASSWORD = `Failure1-${randomBytes(12).toString('hex')}`;

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
    // Every registered cleanup is attempted before any failure is reported, so one that rejects
    // cannot leave the other instance or a pool open. The async wrapper turns a synchronous throw
    // into a rejection, which allSettled collects like the rest.
    const results = await Promise.allSettled(
      cleanups.map(async (cleanup): Promise<void> => cleanup()),
    );
    const reasons = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result): unknown => result.reason);
    if (reasons.length === 1) {
      throw reasons[0];
    }
    if (reasons.length > 1) {
      throw new AggregateError(reasons, `failures teardown: ${reasons.length} cleanups failed`);
    }
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

    /** Every path a route declares, by any method. No route accepts OPTIONS on any of them. */
    const ROUTE_PATHS: readonly string[] = [
      '/signup',
      '/login',
      '/logout',
      '/tasks',
      '/tasks/new',
      '/tasks/1/edit',
      '/tasks/1/status',
      '/tasks/1/delete',
      '/reports',
      '/reports/export',
    ];

    // A signed-in 404 carries `Cache-Control: no-store` like every signed-in response, which
    // also shows that the session was recognised.
    const OPTIONS_CASES = ROUTE_PATHS.flatMap(
      (path) =>
        [
          { path, who: 'anonymous', cacheControl: null },
          { path, who: 'signed in', cacheControl: 'no-store' },
        ] as const,
    );

    it.each(OPTIONS_CASES)(
      'answers OPTIONS $path ($who) with 404 "Page not found." and no Allow list',
      async ({ path, who, cacheControl }) => {
        const client =
          who === 'signed in'
            ? await signUpAndLogIn(healthy, 'options@example.com')
            : healthy.client();

        const res = await client.options(path);

        expectFailurePage(res, 404, 'Page not found.');
        expect(res.headers.get('allow')).toBeNull();
        expect(res.headers.get('cache-control')).toBe(cacheControl);
        expect(errorEntries(healthyLog)).toEqual([]);
      },
    );

    /** A case or trailing-slash variant of a path the application serves. */
    interface PathVariant {
      /** The path as sent. */
      variant: string;
      /** The served path it imitates. `:id` stands for the id of a task the client owns. */
      exact: string;
    }

    // Each variant is followed by its exact path on the same client, so the 404 comes from the
    // path alone and not from a missing session, task or asset.
    const ANONYMOUS_VARIANTS: readonly (PathVariant & { exactStatus: number })[] = [
      { variant: '/TASKS', exact: '/tasks', exactStatus: 302 },
      { variant: '/signup/', exact: '/signup', exactStatus: 200 },
      { variant: '/LOGIN', exact: '/login', exactStatus: 200 },
      { variant: '/STATIC/app.css', exact: '/static/app.css', exactStatus: 200 },
      { variant: '/Static/app.css', exact: '/static/app.css', exactStatus: 200 },
    ];

    it.each(ANONYMOUS_VARIANTS)(
      'answers an anonymous GET $variant with 404 "Page not found.", unlike $exact',
      async ({ variant, exact, exactStatus }) => {
        const client = healthy.client();

        const res = await client.get(variant);

        expectFailurePage(res, 404, 'Page not found.');
        expect(errorEntries(healthyLog)).toEqual([]);
        expect((await client.get(exact)).status).toBe(exactStatus);
      },
    );

    const SIGNED_IN_VARIANTS: readonly PathVariant[] = [
      { variant: '/TASKS', exact: '/tasks' },
      { variant: '/tasks/', exact: '/tasks' },
      { variant: '/tasks/new/', exact: '/tasks/new' },
      { variant: '/TASKS/NEW', exact: '/tasks/new' },
      { variant: '/tasks/:id/edit/', exact: '/tasks/:id/edit' },
      { variant: '/tasks/:id/EDIT', exact: '/tasks/:id/edit' },
      { variant: '/reports/', exact: '/reports' },
      { variant: '/REPORTS', exact: '/reports' },
      { variant: '/reports/export/', exact: '/reports/export' },
      { variant: '/Reports/Export', exact: '/reports/export' },
    ];

    it.each(SIGNED_IN_VARIANTS)(
      'answers a signed-in GET $variant with 404 "Page not found.", unlike $exact',
      async ({ variant, exact }) => {
        const email = 'path-variant@example.com';
        const client = await signUpAndLogIn(healthy, email);
        const ownerId = await userIdByEmail(pool, email);
        if (ownerId === null) {
          throw new Error('the signed-up user was not stored');
        }
        const task = await insertTask(pool, ownerId);
        const withTaskId = (path: string): string => path.replace(':id', String(task.id));

        const res = await client.get(withTaskId(variant));

        expectFailurePage(res, 404, 'Page not found.');
        expect(errorEntries(healthyLog)).toEqual([]);
        expect((await client.get(withTaskId(exact))).status).toBe(200);
      },
    );

    it.each(['/TASKS/NEW/', '/tasks/new/', '/TASKS/NEW'])(
      'answers a signed-in POST %s with 404 "Page not found." and creates no task',
      async (variant) => {
        const client = await signUpAndLogIn(healthy, 'post-variant@example.com');
        const csrf = await taskFormToken(client);
        const before = await countRows(pool, 'tasks');

        const res = await client.post(variant, VALID_TASK_FIELDS, { csrf });

        expectFailurePage(res, 404, 'Page not found.');
        expect(await countRows(pool, 'tasks')).toBe(before);
        expect(errorEntries(healthyLog)).toEqual([]);

        // Control: the same session, token and fields do create a task through the exact path.
        const created = await client.post('/tasks/new', VALID_TASK_FIELDS, { csrf });
        expect(created.status).toBe(303);
        expect(await countRows(pool, 'tasks')).toBe(before + 1);
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

  describe('a failing logger', () => {
    /** What every `error` call of a {@link ThrowingLogger} fails with; no response may carry it. */
    const LOG_SINK_FAILURE = 'log sink failed';

    /** The text the partial route sends before it fails; the connection is cut right after it. */
    const PARTIAL_BODY = 'partial';

    /** One call the error handler made to {@link ThrowingLogger.error}. */
    interface LogAttempt {
      msg: string;
      fields: LogFields | undefined;
    }

    /**
     * A logger whose `error` throws, as the production logger does when its output stream's
     * `write` throws. Each attempt is recorded first, so a case can show that the handler did try
     * to log, under its usual event name and fields.
     */
    class ThrowingLogger extends CaptureLogger {
      /** Every `error` call, in order. */
      readonly attempts: LogAttempt[] = [];

      override error(msg: string, _err?: unknown, fields?: LogFields): void {
        this.attempts.push({ msg, fields });
        throw new Error(LOG_SINK_FAILURE);
      }
    }

    /** Resolves one macrotask later, after anything Express defers with `setImmediate`. */
    function nextMacrotask(): Promise<void> {
      return new Promise<void>((resolve) => setImmediate(resolve));
    }

    /** Drops every open connection, then closes `server`. */
    function stopServer(server: http.Server): Promise<void> {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject): void => {
        server.close((err?: Error): void => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    /**
     * Starts a minimal application on an ephemeral loopback port. Its only route, `GET /partial`,
     * sends status 200 and {@link PARTIAL_BODY}, then fails with `failure()`; the production error
     * handler, logging to `logger`, is mounted after it.
     */
    async function startPartialApp(
      logger: ThrowingLogger,
      failure: () => Error,
    ): Promise<{ server: http.Server; origin: string }> {
      const app = express();
      // Outside the `test` mode, Express's default handler prints the stack with console.error, as
      // on a development or production server. Under Jest's NODE_ENV=test it would stay silent.
      app.set('env', 'development');
      app.get('/partial', (_req, res, next): void => {
        res.status(200);
        // The failure is raised once the text is flushed, so the client already holds the headers
        // and the partial body when the connection is cut.
        res.write(PARTIAL_BODY, (): void => {
          next(failure());
        });
      });
      app.use(createErrorHandler(logger));

      const server = http.createServer(app);
      await new Promise<void>((resolve, reject): void => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', (): void => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        await stopServer(server);
        throw new Error('the partial app has no TCP address');
      }
      return { server, origin: `http://127.0.0.1:${address.port}` };
    }

    /** What a client received: the status, whether the response ended normally, and its text. */
    interface RawResponse {
      status: number | null;
      complete: boolean;
      body: string;
    }

    /**
     * Sends `GET url` on a connection of its own and settles once the response ends or the
     * connection fails; it never rejects. A response cut off mid-body settles with
     * `complete: false` and the text received before the cut.
     */
    function getRaw(url: string): Promise<RawResponse> {
      return new Promise<RawResponse>((resolve): void => {
        const chunks: Buffer[] = [];
        let status: number | null = null;
        let settled = false;
        const settle = (complete: boolean): void => {
          if (!settled) {
            settled = true;
            resolve({ status, complete, body: Buffer.concat(chunks).toString('utf8') });
          }
        };
        const req = http.get(url, { agent: false }, (res): void => {
          status = res.statusCode ?? null;
          res.on('data', (chunk: Buffer): void => {
            chunks.push(chunk);
          });
          res.on('end', (): void => settle(res.complete));
          res.on('error', (): void => settle(false));
          res.on('close', (): void => settle(res.complete));
        });
        req.on('error', (): void => settle(false));
      });
    }

    /** Fails as an unexpected server error would. */
    const failRead = (): never => {
      throw new Error('report read failed');
    };
    const failingReports: ReportService = {
      today: () => '2026-10-21',
      summary: async () => failRead(),
      completions: async () => failRead(),
      exportCsv: async () => failRead(),
    };

    // Express's default handler, once reached, reports the error with console.error.
    let consoleError: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
      // Silenced, so a regression fails on the assertions below instead of printing a stack.
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    /** A request that fails before any byte of its response is sent. */
    interface UnsentCase {
      status: 500 | 503;
      message: string;
      logMsg: 'unexpected error' | 'database unavailable';
      method: 'GET' | 'POST';
      path: string;
      /** Starts the instance the request fails on. */
      start(logger: ThrowingLogger): Promise<TestApp>;
      /** Sends the failing request. */
      send(app: TestApp): Promise<HttpResult>;
    }

    const UNSENT_CASES: readonly UnsentCase[] = [
      {
        status: 500,
        message: 'Something went wrong.',
        logMsg: 'unexpected error',
        method: 'GET',
        path: '/reports',
        start: (logger) => startTestApp({ clock, logger, overrides: { reports: failingReports } }),
        send: async (app) => {
          const client = await signUpAndLogIn(app, 'failing-logger@example.com');
          return client.get('/reports');
        },
      },
      {
        status: 503,
        message: 'Service temporarily unavailable',
        logMsg: 'database unavailable',
        method: 'POST',
        path: '/login',
        start: (logger) => startTestApp({ clock, logger, databaseUrl: UNREACHABLE }),
        send: async (app) => {
          const client = app.client();
          // No `sid` cookie, so the login page needs no database and carries the anonymous token.
          expect((await client.get('/login')).status).toBe(200);
          return client.post('/login', { email: 'failing-logger@example.com', password: PASSWORD });
        },
      },
    ];

    it.each(UNSENT_CASES)(
      'still answers $status "$message" when logging the failure throws',
      async ({ status, message, logMsg, method, path, start, send }) => {
        const logger = new ThrowingLogger();
        const app = await start(logger);
        try {
          const res = await send(app);

          // `<pre>` opens the stack trace that Express's default page shows outside production.
          expectFailurePage(res, status, message, [LOG_SINK_FAILURE, '<pre>']);
          expect(logger.attempts).toEqual([{ msg: logMsg, fields: { method, path } }]);
          await nextMacrotask();
          expect(consoleError).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      },
    );

    const SENT_CASES = [
      {
        name: 'an unexpected error',
        logMsg: 'unexpected error',
        failure: (): Error => new Error('stream failed after the headers'),
      },
      {
        name: 'a database outage',
        logMsg: 'database unavailable',
        failure: (): Error => new DatabaseUnavailableError(),
      },
    ] as const;

    it.each(SENT_CASES)(
      'still cuts off a response already under way when logging $name throws',
      async ({ logMsg, failure }) => {
        const logger = new ThrowingLogger();
        const { server, origin } = await startPartialApp(logger, failure);
        try {
          const received = await getRaw(`${origin}/partial`);

          // Exactly the text sent before the failure, never ended: no default error page or stack
          // was appended, and the client sees the response as truncated.
          expect(received).toEqual({ status: 200, complete: false, body: PARTIAL_BODY });
          expect(logger.attempts).toEqual([
            { msg: logMsg, fields: { method: 'GET', path: '/partial' } },
          ]);
          await nextMacrotask();
          expect(consoleError).not.toHaveBeenCalled();
        } finally {
          await stopServer(server);
        }
      },
    );
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

describe('server start-up and shutdown', () => {
  /** The integration database: already migrated, so a start-up against it applies nothing. */
  const DATABASE_URL = assertTestDatabaseUrl(process.env.DATABASE_URL);

  /** A database role shaped like an email address, as PostgreSQL quotes it in its messages. */
  const EMAIL_ROLE = 'server-role@example.com';

  /** The same role as a connection string carries it. */
  const ENCODED_ROLE = encodeURIComponent(EMAIL_ROLE);

  /** No role's password, assembled at run time so that no literal password sits in the source. */
  const WRONG_PASSWORD = ['wrong', randomBytes(12).toString('hex')].join('-');

  const MARKER = '[redacted]';

  const SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

  /**
   * How long {@link waitForMsg} waits for a line before it rejects. It is well inside the
   * integration project's 30-second test timeout, so a line that never comes fails the case with
   * the line's name while the case is still running.
   */
  const MSG_WAIT_TIMEOUT_MS = 10_000;

  /** How often {@link waitForMsg} re-reads the lines written so far. */
  const MSG_POLL_INTERVAL_MS = 10;

  /** A {@link waitForMsg} call that has not settled yet. */
  interface PendingWait {
    /** Stops the wait's timers and rejects it, naming the line it was waiting for. */
    cancel(): void;
  }

  /** Every unsettled {@link waitForMsg}, so the teardown can stop the ones a case left behind. */
  const pendingWaits = new Set<PendingWait>();

  /** A purge job the server created, with spies on the methods that start and stop its timer. */
  interface CreatedJob {
    job: PurgeJob;
    start: jest.SpiedFunction<PurgeJob['start']>;
    stop: jest.SpiedFunction<PurgeJob['stop']>;
  }

  /** Listeners of one signal, as `process.listeners` returns them. */
  type Listeners = NodeJS.SignalsListener[];

  const originalEnv = process.env;
  let port: number;
  /** The `msg` values whose standard-output write throws, standing in for a failing log stream. */
  let failingMsgs: readonly string[];
  let chunks: string[];
  let listenersBefore: Map<NodeJS.Signals, Listeners>;
  let jobs: CreatedJob[];
  let stdoutWrite: jest.SpiedFunction<typeof process.stdout.write>;
  let createPoolSpy: jest.SpiedFunction<typeof poolModule.createPool>;
  let createPurgeJobSpy: jest.SpiedFunction<typeof purgeJobModule.createPurgeJob>;
  let createServerSpy: jest.SpiedFunction<typeof http.createServer>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  /** Settles at the first `process.exit` call. */
  let exited: Promise<void>;
  /** Registered on the host process, so it observes a real unhandled rejection. */
  let unhandled: jest.Mock<void, [unknown, Promise<unknown>]>;

  /** A port that was free a moment ago: bound to port 0, read back, then released. */
  function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, () => {
        const address = probe.address();
        probe.close(() => {
          if (address === null || typeof address === 'string') {
            reject(new Error('the port probe has no TCP address'));
          } else {
            resolve(address.port);
          }
        });
      });
    });
  }

  /** Whether a TCP connection to `port` on the loopback interface is accepted. */
  function isListening(target: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ port: target, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /** {@link DATABASE_URL} with its user name and password replaced; the URL encodes both. */
  function withCredentials(user: string, password: string): string {
    const url = new URL(DATABASE_URL);
    url.username = user;
    url.password = password;
    return url.toString();
  }

  /** The lines written to standard output so far, parsed. */
  function logged(): Record<string, unknown>[] {
    return chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('server test: a log line is not a JSON object');
        }
        return { ...parsed };
      });
  }

  /** The `msg` of every line written so far, in order. */
  function loggedMsgs(): unknown[] {
    return logged().map((entry) => entry.msg);
  }

  /**
   * Polls until a line with `msg` has been written. It rejects, naming `msg`, when no such line
   * arrives within {@link MSG_WAIT_TIMEOUT_MS}, when the lines cannot be read, or when the
   * teardown cancels it. Jest's test timeout fails a case without stopping its body, so the wait
   * carries its own deadline and registers in {@link pendingWaits}; no timer of it outlives the
   * case.
   */
  function waitForMsg(msg: string): Promise<void> {
    let pollTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let settle: (failure: { reason: unknown } | null) => void = () => undefined;
    const arrival = new Promise<void>((resolve, reject) => {
      settle = (failure): void => {
        clearTimeout(pollTimer);
        clearTimeout(deadlineTimer);
        pendingWaits.delete(wait);
        if (failure === null) {
          resolve();
        } else {
          reject(failure.reason);
        }
      };
    });
    const wait: PendingWait = {
      cancel: (): void => {
        // A case may end without awaiting its wait, and the cancellation must not then become an
        // unhandled rejection. The no-op handler sits on a derived promise: a test that awaits
        // the wait still receives the rejection.
        arrival.catch(() => undefined);
        settle({ reason: new Error(`server test: the wait for a "${msg}" line was cancelled`) });
      },
    };
    const poll = (): void => {
      let arrived: boolean;
      try {
        arrived = loggedMsgs().includes(msg);
      } catch (err: unknown) {
        settle({ reason: err });
        return;
      }
      if (arrived) {
        settle(null);
      } else {
        pollTimer = setTimeout(poll, MSG_POLL_INTERVAL_MS);
      }
    };
    deadlineTimer = setTimeout(() => {
      settle({
        reason: new Error(`server test: no "${msg}" line within ${MSG_WAIT_TIMEOUT_MS} ms`),
      });
    }, MSG_WAIT_TIMEOUT_MS);
    pendingWaits.add(wait);
    poll();
    return arrival;
  }

  /** The `SIGTERM` and `SIGINT` listeners added since the case began. */
  function addedListeners(): Listeners {
    return SIGNALS.flatMap((signal) => {
      const before = listenersBefore.get(signal) ?? [];
      return process.listeners(signal).filter((listener) => !before.includes(listener));
    });
  }

  /** The pools the server created. */
  function createdPools(): Pool[] {
    return createPoolSpy.mock.results.flatMap((result) =>
      result.type === 'return' ? [result.value] : [],
    );
  }

  /** Resolves after one macrotask, by when Node has reported any unhandled rejection. */
  function nextMacrotask(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(async () => {
    port = await freePort();
    process.env = {
      ...originalEnv,
      DATABASE_URL,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      PORT: String(port),
      NODE_ENV: 'test',
    };
    process.exitCode = undefined;
    failingMsgs = [];
    chunks = [];
    listenersBefore = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
    jobs = [];

    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        if (failingMsgs.some((msg) => text.includes(`"msg":${JSON.stringify(msg)}`))) {
          throw new Error('standard output write failed');
        }
        chunks.push(text);
        return true;
      });
    createPoolSpy = jest.spyOn(poolModule, 'createPool');
    createServerSpy = jest.spyOn(http, 'createServer');
    const realCreatePurgeJob = purgeJobModule.createPurgeJob;
    createPurgeJobSpy = jest
      .spyOn(purgeJobModule, 'createPurgeJob')
      .mockImplementation((deps): PurgeJob => {
        const job = realCreatePurgeJob(deps);
        jobs.push({ job, start: jest.spyOn(job, 'start'), stop: jest.spyOn(job, 'stop') });
        return job;
      });
    let markExited: () => void = () => undefined;
    exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    // The real call would end Jest itself; the shutdown's last step is recorded instead.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((): never => {
      markExited();
      return undefined as never;
    });
    unhandled = jest.fn<void, [unknown, Promise<unknown>]>();
    hostProcess.on('unhandledRejection', unhandled);
  });

  afterEach(async () => {
    // Every step is attempted on its own and its failure collected, so a stop that throws or a
    // close that rejects can neither leave the remaining resources open nor skip the restores.
    const errors: unknown[] = [];
    const attempt = async (step: () => void | Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (err: unknown) {
        errors.push(err);
      }
    };
    try {
      // A wait the case left polling is stopped first, so it reads no later case's lines.
      for (const wait of [...pendingWaits]) {
        await attempt(() => {
          wait.cancel();
        });
      }
      // Releases whatever a failed case left behind, so no listener, timer, socket or connection
      // outlives it. Each list is read inside an attempt as well: a set-up that failed part-way
      // can leave it unassigned.
      for (const signal of SIGNALS) {
        await attempt(() => {
          const before = listenersBefore.get(signal) ?? [];
          for (const listener of process.listeners(signal)) {
            if (!before.includes(listener)) {
              process.removeListener(signal, listener);
            }
          }
        });
      }
      await attempt(async () => {
        for (const { job } of jobs) {
          await attempt(() => {
            job.stop();
          });
        }
      });
      await attempt(async () => {
        for (const result of createServerSpy.mock.results) {
          if (result.type === 'return' && result.value.listening) {
            const server = result.value;
            await attempt(
              () =>
                new Promise<void>((resolve, reject) => {
                  server.close((err) => (err === undefined ? resolve() : reject(err)));
                  server.closeAllConnections();
                }),
            );
          }
        }
      });
      await attempt(async () => {
        for (const pool of createdPools()) {
          if (!pool.ended && !pool.ending) {
            await attempt(() => pool.end());
          }
        }
      });
    } finally {
      // Restores the spies, the environment and the exit code whatever the cleanup did, so no
      // later case runs against this case's mocks or state.
      await attempt(() => {
        hostProcess.off('unhandledRejection', unhandled);
      });
      await attempt(() => {
        exitSpy.mockRestore();
      });
      await attempt(() => {
        createPurgeJobSpy.mockRestore();
      });
      await attempt(() => {
        createServerSpy.mockRestore();
      });
      await attempt(() => {
        createPoolSpy.mockRestore();
      });
      await attempt(() => {
        stdoutWrite.mockRestore();
      });
      process.env = originalEnv;
      // Left set, the server's exit code would become Jest's own.
      process.exitCode = undefined;
    }
    if (errors.length > 0) {
      // Reported only now, after every cleanup and restore has been attempted.
      throw new AggregateError(errors, 'server test teardown failed');
    }
  });

  it('logs a failed sign-in of an email-shaped role once, redacted, and exits 1', async () => {
    const databaseUrl = withCredentials(EMAIL_ROLE, WRONG_PASSWORD);
    expect(databaseUrl).toContain(`//${ENCODED_ROLE}:${WRONG_PASSWORD}@`);
    process.env.DATABASE_URL = databaseUrl;

    await expect(startServer()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const entries = logged();
    expect(entries.map((entry) => entry.msg)).toEqual(['migration failed']);
    expect(entries[0]).toMatchObject({
      level: 'error',
      err: {
        code: '28P01',
        message: `password authentication failed for user "${MARKER}"`,
        stack: expect.stringContaining(`for user "${MARKER}"`),
      },
    });
    const text = chunks.join('');
    for (const secret of [EMAIL_ROLE, ENCODED_ROLE, WRONG_PASSWORD]) {
      expect(text).not.toContain(secret);
    }
    expect(await isListening(port)).toBe(false);
    expect(createdPools().map((pool) => pool.ended)).toEqual([true]);
    expect(jobs).toEqual([]);
    expect(addedListeners()).toEqual([]);
  });

  it.each<[string, readonly string[], 'configured' | 'wrong', readonly string[]]>([
    ['the "migration failed" line', ['migration failed'], 'wrong', []],
    [
      'the "server listening" line',
      ['server listening'],
      'configured',
      ['migrations applied', 'startup failed'],
    ],
    [
      'the "server listening" and "startup failed" lines',
      ['server listening', 'startup failed'],
      'configured',
      ['migrations applied'],
    ],
  ])(
    'exits 1 leaving nothing running when %s cannot be written',
    async (_label, failing, credentials, expectedMsgs) => {
      if (credentials === 'wrong') {
        process.env.DATABASE_URL = withCredentials(EMAIL_ROLE, WRONG_PASSWORD);
      }
      failingMsgs = failing;

      await expect(startServer()).resolves.toBeUndefined();
      await nextMacrotask();

      expect(process.exitCode).toBe(1);
      expect(loggedMsgs()).toEqual(expectedMsgs);
      expect(await isListening(port)).toBe(false);
      for (const { start } of jobs) {
        expect(start).not.toHaveBeenCalled();
      }
      expect(addedListeners()).toEqual([]);
      expect(createdPools().map((pool) => pool.ended)).toEqual([true]);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    },
  );

  it.each<[string, readonly string[], readonly Record<string, unknown>[]]>([
    [
      'every line is written',
      [],
      [{ level: 'info', msg: 'shutting down', signal: 'SIGTERM' }],
    ],
    ['the "shutting down" line cannot be written', ['shutting down'], []],
  ])(
    'shuts down on SIGTERM and exits 0 exactly once when %s',
    async (_label, failing, expectedLines) => {
      failingMsgs = failing;

      await expect(startServer()).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
      expect(await isListening(port)).toBe(true);
      expect(addedListeners()).toHaveLength(SIGNALS.length);
      // The purge the start-up began is left to finish, so the shutdown drains an idle pool.
      await waitForMsg('purge completed');

      process.emit('SIGTERM', 'SIGTERM');
      // The other signal, delivered during the shutdown, reaches the re-entry guard.
      process.emit('SIGINT', 'SIGINT');
      await exited;
      await nextMacrotask();

      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      const shutdownLines = logged().filter(
        (entry) => entry.msg === 'shutting down' || entry.msg === 'shutdown failed',
      );
      expect(shutdownLines).toEqual(expectedLines.map((line) => expect.objectContaining(line)));
      expect(await isListening(port)).toBe(false);
      expect(jobs.map(({ stop }) => stop.mock.calls.length)).toEqual([1]);
      expect(createdPools().map((pool) => pool.ended)).toEqual([true]);
      expect(addedListeners()).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();
    },
  );

  /**
   * How long a shutdown case waits for any one step. It is far inside the 30-second test timeout,
   * so a shutdown that hangs fails the case, naming the step, while the case is still running.
   */
  const SHUTDOWN_STEP_MS = 5_000;

  /** The one HTTP server the start-up created. */
  function createdServer(): http.Server {
    const servers = createServerSpy.mock.results.flatMap((result) =>
      result.type === 'return' ? [result.value] : [],
    );
    const [server] = servers;
    if (servers.length !== 1 || server === undefined) {
      throw new Error(`server test: the start-up created ${servers.length} servers, not one`);
    }
    return server;
  }

  /** Settles as `promise` does, or rejects naming `what` after {@link SHUTDOWN_STEP_MS}. */
  async function within<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`server test: ${what} did not happen within ${SHUTDOWN_STEP_MS} ms`));
      }, SHUTDOWN_STEP_MS);
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Polls until `done()` holds, rejecting naming `what` after {@link SHUTDOWN_STEP_MS}. */
  async function until(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_STEP_MS;
    while (!done()) {
      if (Date.now() >= deadline) {
        throw new Error(`server test: ${what} did not happen within ${SHUTDOWN_STEP_MS} ms`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  it.each<[string, string]>([
    ['no byte', ''],
    ['headers without the final CRLF', 'GET /login HTTP/1.1\r\nHost: 127.0.0.1\r\n'],
    [
      'a POST with Content-Length 100 and 7 body bytes',
      'POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        'Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\nemail=a',
    ],
  ])('exits 0 at once on SIGTERM while a connection has sent %s', async (_label, payload) => {
    await expect(startServer()).resolves.toBeUndefined();
    await waitForMsg('purge completed');
    const server = createdServer();
    const accepted = new Promise<net.Socket>((resolve) => {
      server.once('connection', resolve);
    });
    const client = net.connect({ port, host: '127.0.0.1' });
    let signalled = false;
    try {
      // A reset closes the client as well; which of the two ends it is not what the case checks.
      client.on('error', () => undefined);
      const clientClosed = new Promise<void>((resolve) => {
        client.once('close', () => resolve());
      });
      if (payload !== '') {
        client.write(payload);
      }
      const socket = await within(accepted, 'the connection');
      // Once the server has read every byte sent, the signal finds the state under test.
      const length = Buffer.byteLength(payload);
      await until(() => socket.bytesRead === length, `the receipt of ${length} bytes`);

      signalled = true;
      process.emit('SIGTERM', 'SIGTERM');
      await within(exited, 'the exit');
      await within(clientClosed, 'the close of the client socket');
      await nextMacrotask();

      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(await isListening(port)).toBe(false);
      expect(createdPools().map((pool) => pool.ended)).toEqual([true]);
      // The body cut short becomes body-parser's 400 `request.aborted`, which is never logged.
      expect(logged().filter((entry) => entry.level === 'error')).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      if (signalled) {
        // A drain that this socket held open ends once it closes. Awaiting that shutdown keeps
        // its `process.exit` call out of the next case, whose spy would otherwise record it.
        await within(exited, 'the exit after the client closed').catch(() => undefined);
      }
    }
  });

  it('answers a request received before SIGTERM in full, then exits 0', async () => {
    await expect(startServer()).resolves.toBeUndefined();
    await waitForMsg('purge completed');
    const server = createdServer();
    const client = new HttpClient(`http://127.0.0.1:${port}`);
    expect((await client.get('/login')).status).toBe(200);
    /** For each signal sent, whether the response had still to be sent when it arrived. */
    const unsentAtSignal: boolean[] = [];
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse): void => {
      // `end` fires once body-parser has read the whole form: the request is received in full,
      // and the login handler is still checking the credentials against the database.
      req.once('end', (): void => {
        unsentAtSignal.push(!res.headersSent);
        process.emit('SIGTERM', 'SIGTERM');
      });
    });

    const email = `in-flight-${randomUUID()}@example.com`;
    const result = await within(client.post('/login', { email, password: PASSWORD }), 'the login');
    await within(exited, 'the exit');
    await nextMacrotask();

    expect(unsentAtSignal).toEqual([true]);
    expect(result.status).toBe(422);
    expect(result.body).toContain('Email or password is incorrect.');
    expect(result.body).toMatch(/<\/html>\s*$/);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(await isListening(port)).toBe(false);
    expect(createdPools().map((pool) => pool.ended)).toEqual([true]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it.each<[NodeJS.Signals, NodeJS.Signals]>([
    ['SIGTERM', 'SIGINT'],
    ['SIGINT', 'SIGTERM'],
  ])('exits 1 at once on a repeated %s while the drain cannot finish', async (signal, other) => {
    await expect(startServer()).resolves.toBeUndefined();
    await waitForMsg('purge completed');
    const [pool] = createdPools();
    if (pool === undefined) {
      throw new Error('server test: the start-up created no pool');
    }
    // The shutdown's last step is held, so its drain cannot finish until the case releases it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const endPool = pool.end.bind(pool);
    let ending: Promise<void> = Promise.resolve();
    const endSpy = jest.spyOn(pool, 'end').mockImplementation((): Promise<void> => {
      markReached();
      ending = held.then(() => endPool());
      return ending;
    });
    try {
      process.emit(signal, signal);
      await within(reached, 'the call that ends the pool');
      process.emit(other, other);
      expect(exitSpy).not.toHaveBeenCalled();

      process.emit(signal, signal);

      expect(exitSpy.mock.calls).toEqual([[1]]);
      expect(logged().filter((entry) => entry.level === 'error')).toEqual([
        expect.objectContaining({
          msg: 'shutdown failed',
          err: expect.objectContaining({ message: `${signal} received again during the shutdown` }),
        }),
      ]);
    } finally {
      // The real exit would have ended the process. With it mocked, the held step is released and
      // the drain runs to its own end, so the case leaves no server, pool or listener behind.
      release();
      await ending;
      await nextMacrotask();
      endSpy.mockRestore();
    }
    expect(exitSpy.mock.calls).toEqual([[1], [0]]);
    expect(createdPools().map((created) => created.ended)).toEqual([true]);
    expect(addedListeners()).toEqual([]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  /** Tasks seeded for the buffered-export case. */
  const EXPORT_TASK_COUNT = 5_000;

  /** The description length of each of them: the 5,000-character maximum the schema allows. */
  const EXPORT_DESCRIPTION_CHARS = 5_000;

  /**
   * The smallest export body the buffered-export case accepts. Loopback socket buffers hold a few
   * megabytes, so most of a body this large is still queued in the process when its response ends.
   */
  const MIN_EXPORT_BYTES = 20_000_000;

  /** The UTC day every seeded task was created on, and the export's one-day range. */
  const EXPORT_DAY = '2026-10-21';

  /** A response's write state one macrotask after its `end` call returned. */
  interface ResponseAtSignal {
    writableEnded: boolean;
    writableFinished: boolean;
    writableLength: number;
  }

  it('delivers a response ended but still buffered at SIGTERM in full, then exits 0', async () => {
    await expect(startServer()).resolves.toBeUndefined();
    await waitForMsg('purge completed');
    const server = createdServer();
    const [pool] = createdPools();
    if (pool === undefined) {
      throw new Error('server test: the start-up created no pool');
    }
    const email = `slow-reader-${randomUUID()}@example.com`;
    const session = new HttpClient(`http://127.0.0.1:${port}`);
    expect((await session.get('/signup')).status).toBe(200);
    expect((await session.post('/signup', { email, password: PASSWORD })).status).toBe(303);
    expect((await session.get('/login')).status).toBe(200);
    expect((await session.post('/login', { email, password: PASSWORD })).status).toBe(303);
    const ownerId = await userIdByEmail(pool, email);
    if (ownerId === null) {
      throw new Error('server test: the signed-up user has no row');
    }
    await sql(
      pool,
      'INSERT INTO tasks (owner_id, title, description, created_at, updated_at) ' +
        "SELECT $1::bigint, 'Export task ' || n, repeat('x', $2::int), $3::timestamptz, " +
        '$3::timestamptz FROM generate_series(1, $4::int) AS n',
      [ownerId, EXPORT_DESCRIPTION_CHARS, `${EXPORT_DAY}T12:00:00.000Z`, EXPORT_TASK_COUNT],
    );

    let signalled = false;
    const atSignal = new Promise<ResponseAtSignal>((resolve) => {
      server.on('request', (req: http.IncomingMessage, res: http.ServerResponse): void => {
        if (req.url?.startsWith('/reports/export?') !== true) {
          return;
        }
        // The proxy keeps every overload of `end`. One macrotask after the call returns, the
        // response has ended, but most of the body still waits behind the paused reader.
        res.end = new Proxy(res.end, {
          apply: (end, thisArg: unknown, args: unknown[]): unknown => {
            const result: unknown = Reflect.apply(end, thisArg, args);
            setImmediate((): void => {
              resolve({
                writableEnded: res.writableEnded,
                writableFinished: res.writableFinished,
                writableLength: res.writableLength,
              });
              signalled = true;
              process.emit('SIGTERM', 'SIGTERM');
            });
            return result;
          },
        });
      });
    });

    const client = net.connect({ port, host: '127.0.0.1' });
    // Paused before any byte arrives, so the client reads nothing until the case resumes it: the
    // loopback buffers fill, and the rest of the body stays queued in the server process.
    client.pause();
    const received: Buffer[] = [];
    client.on('data', (chunk: Buffer): void => {
      received.push(chunk);
    });
    let clientError: Error | null = null;
    client.on('error', (err: Error): void => {
      clientError = err;
    });
    const clientClosed = new Promise<void>((resolve) => {
      client.once('close', () => resolve());
    });
    try {
      // A keep-alive request, so it is the shutdown that closes the connection once it is done.
      client.write(
        `GET /reports/export?from=${EXPORT_DAY}&to=${EXPORT_DAY}&status= HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\nCookie: sid=${sessionCookie(session)}\r\n\r\n`,
      );
      const state = await within(atSignal, 'the end of the export response');
      expect(state).toEqual({
        writableEnded: true,
        writableFinished: false,
        writableLength: expect.any(Number),
      });
      expect(state.writableLength).toBeGreaterThan(0);

      client.resume();
      await within(clientClosed, 'the close of the client socket');
      await within(exited, 'the exit');
      await nextMacrotask();

      const response = Buffer.concat(received);
      const headEnd = response.indexOf('\r\n\r\n');
      expect(headEnd).toBeGreaterThan(0);
      const head = response.subarray(0, headEnd).toString('latin1');
      const body = response.subarray(headEnd + 4);
      expect(head).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      const advertised = /\r\ncontent-length: *(\d+)\r\n/i.exec(`${head}\r\n`)?.[1];
      expect(advertised).toBeDefined();
      const contentLength = Number(advertised);
      expect(contentLength).toBeGreaterThanOrEqual(MIN_EXPORT_BYTES);
      // Every advertised byte arrived and nothing followed: the connection carried no more.
      expect(body.length).toBe(contentLength);
      // The header row and one record per task, each terminated by CRLF.
      expect(body.toString('utf8').split('\r\n').length - 1).toBe(EXPORT_TASK_COUNT + 1);
      expect(clientError).toBeNull();
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(await isListening(port)).toBe(false);
      expect(createdPools().map((created) => created.ended)).toEqual([true]);
      expect(logged().filter((entry) => entry.level === 'error')).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      if (signalled) {
        // Awaiting the shutdown keeps its `process.exit` call out of the next case's spy.
        await within(exited, 'the exit after the client closed').catch(() => undefined);
      }
    }
  });
});

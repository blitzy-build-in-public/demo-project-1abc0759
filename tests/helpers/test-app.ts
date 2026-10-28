/**
 * The in-process application for integration tests: the real production stack, listening on an
 * ephemeral loopback port.
 *
 * `createPool` → `createDataAccess` → the three services → `createApp`, exactly as `src/server.ts`
 * wires them. Only the clock (a {@link FakeClock}), the logger (a {@link CaptureLogger}) and the
 * session secret (random per instance unless given) differ from production. Migrations are not
 * run here: the integration global setup applies them once before any suite.
 *
 * Two instances started against the same test database, each with its own pool, are how the
 * suites emulate replicas. The module is runner-neutral and holds no module-level state: every
 * call to {@link startTestApp} builds a fresh stack.
 *
 * {@link gateAuthenticate} and {@link sendHeldGet} hold one request in `loadSession` while the
 * test decides its fate, which is how the suites abandon a request at a known point before its
 * route handler runs.
 */

import { randomBytes } from 'node:crypto';
import { IncomingMessage, createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import type { Pool } from 'pg';

import { createAuthService } from '../../src/auth/auth-service';
import type { AuthService, AuthenticatedUser } from '../../src/auth/auth-service';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { AppConfig } from '../../src/config';
import { createDataAccess } from '../../src/db/data-access';
import type { DataAccess } from '../../src/db/data-access';
import { createPool } from '../../src/db/pool';
import { createReportService } from '../../src/reports/report-service';
import type { ReportService } from '../../src/reports/report-service';
import { createTaskService } from '../../src/tasks/task-service';
import type { TaskService } from '../../src/tasks/task-service';

import { CaptureLogger } from './capture-logger';
import { FakeClock } from './fake-clock';
import { HttpClient } from './http-client';
import { assertTestDatabaseUrl, testDatabaseUrl } from './test-db';

/** Interface the test server binds to; the base URL names the same address. */
const LOOPBACK_HOST = '127.0.0.1';

/** Bytes of randomness in a default session secret: 64 hex characters, above the 32 floor. */
const SESSION_SECRET_BYTES = 32;

/**
 * How long {@link sendHeldGet} waits, after the held `authenticate` call has answered, for the
 * route handler to run. The middleware after `loadSession` and the handler's start up to its
 * first query are synchronous, so a query it starts is counted before any timer fires; the wait
 * is a margin, not the guarantee.
 */
const SETTLE_MS = 50;

/** Options for {@link startTestApp}. Every field is optional. */
export interface TestAppOptions {
  /**
   * The clock injected into the services and the application. Default: a new `FakeClock` at
   * its default start instant. Pass one to set or advance time from the test.
   */
  clock?: FakeClock;
  /**
   * The logger injected into the pool and the application's error handler. Default: a new,
   * empty `CaptureLogger`.
   */
  logger?: CaptureLogger;
  /**
   * Connection string for this instance's pool. Default: `DATABASE_URL` from the environment.
   * The `_test` name guard applies either way, so an unreachable URL for the
   * database-unavailable tests must still name a `_test` database, for example
   * `postgres://tasktracker:x@127.0.0.1:1/unreachable_test`.
   */
  databaseUrl?: string;
  /**
   * Key for cookie signatures and CSRF tokens. Default: 32 fresh random bytes as hex, so each
   * instance's sessions are its own. Two instances that must accept each other's session
   * cookies pass the same value.
   */
  sessionSecret?: string;
  /** Runtime mode. Default `'test'`; `'production'` adds `Secure` to both cookies. */
  nodeEnv?: AppConfig['nodeEnv'];
  /**
   * Services that replace the real ones, for example a report service whose `summary` throws.
   * Services not named here are built on this instance's data access and clock.
   */
  overrides?: Partial<{ auth: AuthService; tasks: TaskService; reports: ReportService }>;
}

/** A running in-process application and the parts it was built from. */
export interface TestApp {
  /** Origin of the listening server, `http://127.0.0.1:<port>`, with no trailing slash. */
  baseUrl: string;
  /**
   * The HTTP server the application listens on, stopped by {@link TestApp.close}. It gives a test
   * the server side of a connection, for example to wait until the server has seen a client
   * disconnect.
   */
  server: Server;
  /** The configuration the application was built with. */
  config: AppConfig;
  /** The clock shared by the services and the application. */
  clock: FakeClock;
  /** The logger receiving the pool's and the error handler's entries. */
  logger: CaptureLogger;
  /** This instance's own pool, ended by {@link TestApp.close}. */
  pool: Pool;
  /** The data-access facade over {@link TestApp.pool}. */
  dal: DataAccess;
  /** The auth service actually wired into the application, an override included. */
  auth: AuthService;
  /** The task service actually wired into the application, an override included. */
  tasks: TaskService;
  /** The report service actually wired into the application, an override included. */
  reports: ReportService;
  /**
   * Returns a new client bound to {@link TestApp.baseUrl} with an empty cookie jar, so each
   * simulated user is isolated from every other.
   */
  client(): HttpClient;
  /**
   * Ends every open connection, stops the server and ends the pool. Idempotent: later calls
   * return the first call's promise, because ending a `pg` pool twice throws.
   */
  close(): Promise<void>;
}

/**
 * Starts listening on an ephemeral loopback port and returns the bound address.
 *
 * Rejects with the server's `error` event when the bind fails, in which case nothing is
 * listening. When the bound address is not a TCP address, the server is closed before the
 * rejection, so the caller has nothing to stop.
 */
async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject): void => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(0, LOOPBACK_HOST, (): void => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address !== 'object') {
    await stopServer(server);
    throw new Error('startTestApp: server has no TCP address');
  }
  return address;
}

/**
 * Destroys every open socket, keep-alive sockets from `fetch` included, then closes the server,
 * so Jest exits without open handles. Both calls run in the same tick, so no connection can be
 * accepted between them.
 */
function stopServer(server: Server): Promise<void> {
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
 * Builds the real application stack in process and starts it on an ephemeral port of
 * `127.0.0.1`.
 *
 * The pool, data access, services, application factory, middleware, templates and SQL are the
 * production ones; only the clock, the logger and the session secret differ. The same clock goes
 * to every service and to the application, so advancing it moves session expiry, the lockout
 * window, "today" and the default report range together. The pool connects lazily, so an
 * unreachable database fails per request with a 503 rather than here.
 *
 * The caller must `await app.close()` when done, normally in `afterAll`, or the server and the
 * pool keep the test process alive.
 *
 * @param opts - Clock, logger, database URL, session secret, mode and service overrides.
 * @returns The running application and the parts it was built from.
 * @throws Error when the database URL fails the `_test` guard.
 * @throws ConfigError when the session secret is shorter than 32 characters or the URL is not a
 *   valid `postgres://` connection string.
 * @throws The bind error when the server cannot listen; the pool is ended first.
 */
export async function startTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const databaseUrl = assertTestDatabaseUrl(opts.databaseUrl ?? testDatabaseUrl());
  const sessionSecret = opts.sessionSecret ?? randomBytes(SESSION_SECRET_BYTES).toString('hex');

  // PORT is deliberately left out: loadConfig accepts only 1 to 65535, so the ephemeral port 0
  // cannot pass through it. config.port then defaults to 3000 and is never used here, because
  // the server below listens on port 0 itself.
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: sessionSecret,
    NODE_ENV: opts.nodeEnv ?? 'test',
  });

  const clock = opts.clock ?? new FakeClock();
  const logger = opts.logger ?? new CaptureLogger();

  const pool = createPool(config.databaseUrl, logger);
  try {
    const dal = createDataAccess(pool);
    const auth = opts.overrides?.auth ?? createAuthService({ dal, clock });
    const tasks = opts.overrides?.tasks ?? createTaskService({ dal, clock });
    const reports = opts.overrides?.reports ?? createReportService({ dal, clock });

    const app = createApp({ config, clock, logger, auth, tasks, reports });
    const server: Server = createServer(app);
    const address = await listenOnLoopback(server);
    const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;

    let closing: Promise<void> | null = null;
    const closeOnce = async (): Promise<void> => {
      try {
        await stopServer(server);
      } finally {
        await pool.end();
      }
    };

    return {
      baseUrl,
      server,
      config,
      clock,
      logger,
      pool,
      dal,
      auth,
      tasks,
      reports,
      client(): HttpClient {
        return new HttpClient(baseUrl);
      },
      close(): Promise<void> {
        closing ??= closeOnce();
        return closing;
      },
    };
  } catch (err) {
    // A failed start must leak no handles: the server is already stopped or never listened, so
    // the pool is the only resource left open.
    await pool.end();
    throw err;
  }
}

/** A promise with its settle functions, which Node 20's `Promise` has no built-in for. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** Returns a new pending {@link Deferred}. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => undefined;
  let reject: (reason: unknown) => void = (): void => undefined;
  const promise = new Promise<T>((onResolve, onReject): void => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * An auth service whose `authenticate` waits at a gate the test opens, so a request can be acted
 * on while `loadSession` holds it, before any route handler runs.
 */
export interface AuthGate {
  /** The real service, except that every `authenticate` call first waits for the gate to open. */
  auth: AuthService;
  /** Resolves when the first `authenticate` call has reached the gate. */
  entered: Promise<void>;
  /**
   * Settles as the real `authenticate` settles for that first call, once the gate has opened:
   * with the signed-in user, or `null` for an unknown or expired session.
   */
  answered: Promise<AuthenticatedUser | null>;
  /** Opens the gate; calls arriving later pass straight through. Idempotent. */
  release(): void;
}

/**
 * Wraps a real auth service in an {@link AuthGate}. Every other method is the real one.
 *
 * @param real - The service that answers once the gate is open.
 * @returns The gate, closed.
 */
export function gateAuthenticate(real: AuthService): AuthGate {
  const opened = deferred<void>();
  const entered = deferred<void>();
  const answered = deferred<AuthenticatedUser | null>();
  // A test that fails before reading `answered` must not leave its rejection unhandled.
  answered.promise.catch((): void => undefined);
  let first = true;

  return {
    auth: {
      ...real,
      async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
        const recorded = first;
        first = false;
        if (recorded) {
          entered.resolve();
        }
        await opened.promise;
        try {
          const user = await real.authenticate(sessionToken);
          if (recorded) {
            answered.resolve(user);
          }
          return user;
        } catch (err: unknown) {
          if (recorded) {
            answered.reject(err);
          }
          throw err;
        }
      },
    },
    entered: entered.promise,
    answered: answered.promise,
    release(): void {
      opened.resolve();
    },
  };
}

/** What {@link sendHeldGet} does with the request while the gate holds it. */
export type HeldGetOutcome = 'abandon' | 'answer';

/**
 * Sends `GET path` to `app` over a fresh connection with the given `Cookie` header, then acts on
 * it while `gate` holds it in `loadSession`:
 *
 * - `'answer'`: opens the gate and resolves with the status of the complete response.
 * - `'abandon'`: destroys the request on the client side and waits until the server-side socket
 *   of the held request has closed, so `req.socket.destroyed` is already `true` when the gate
 *   opens. It then opens the gate, waits for the real `authenticate` to answer and for the
 *   handler to run, and resolves with `null`, since no response can arrive.
 *
 * `app` must be built with `gate.auth` as its auth service, and `cookie` must carry a session the
 * instance accepts, or the request never reaches the gate.
 *
 * @param app - The instance under test.
 * @param gate - The gate wired into `app`, still closed.
 * @param path - The request path and query.
 * @param cookie - The `Cookie` request header, for example `sid=<signed value>`.
 * @param outcome - Whether the client waits for the response or abandons the request.
 * @returns The response status, or `null` for an abandoned request.
 * @throws Error, for either outcome, when the response arrives before the request reaches the
 *   gate, or when the connection or the response stream fails, or the response has no status,
 *   before the gate is reached.
 * @throws For `'answer'`, the same connection, stream and missing-status errors once the gate
 *   opens. HTTP error responses resolve with their status instead, such as the 503 or 500 page
 *   for a rejection from the real `authenticate`.
 * @throws For `'abandon'`, a rejection from the real `authenticate` call, and an Error when the
 *   server-side socket of the held request closes without being destroyed.
 */
export async function sendHeldGet(
  app: TestApp,
  gate: AuthGate,
  path: string,
  cookie: string,
  outcome: HeldGetOutcome,
): Promise<number | null> {
  const arrived = new Promise<IncomingMessage>((resolve): void => {
    app.server.once('request', (req: IncomingMessage): void => {
      resolve(req);
    });
  });
  const client = request(`${app.baseUrl}${path}`, { headers: { cookie }, agent: false });
  const response = new Promise<number>((resolve, reject): void => {
    client.once('response', (res: IncomingMessage): void => {
      res.once('error', reject);
      res.once('end', (): void => {
        if (res.statusCode === undefined) {
          reject(new Error('sendHeldGet: the response has no status'));
        } else {
          resolve(res.statusCode);
        }
      });
      res.resume();
    });
    client.once('error', reject);
  });
  // An abandoned request rejects with "socket hang up"; the awaits below still see a rejection.
  response.catch((): void => undefined);
  client.end();

  await Promise.race([
    gate.entered,
    response.then((status): never => {
      throw new Error(`sendHeldGet: answered ${status} before reaching the gate`);
    }),
  ]);

  if (outcome === 'answer') {
    gate.release();
    return response;
  }

  const held = await arrived;
  const closed = new Promise<void>((resolve): void => {
    held.socket.once('close', (): void => {
      resolve();
    });
  });
  client.destroy();
  await closed;
  if (!held.socket.destroyed) {
    throw new Error('sendHeldGet: the server-side socket closed without being destroyed');
  }
  gate.release();
  await gate.answered;
  await delay(SETTLE_MS);
  return null;
}

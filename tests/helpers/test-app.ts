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
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Pool } from 'pg';

import { createAuthService } from '../../src/auth/auth-service';
import type { AuthService } from '../../src/auth/auth-service';
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

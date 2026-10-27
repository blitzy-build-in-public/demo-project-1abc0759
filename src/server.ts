/**
 * Process entry point: `node dist/server.js` is the container command, `npm start`,
 * `npm run start:local` and the Playwright end-to-end web server.
 *
 * This is composition-root code. It reads the environment (with `src/db/migrate-cli.ts`, the only
 * file that does): it first fixes libuv's thread-pool size by setting `UV_THREADPOOL_SIZE`, then
 * passes the environment straight to `src/config.ts`. It builds the pool, applies the pending
 * migrations, constructs the services and the application, listens, starts the scheduled purge,
 * and is the only file that handles signals. Importing it starts nothing: the thread-pool size is
 * set, and {@link main} runs, only when this file is the process entry.
 *
 * The configuration is never logged, whole or in part: `DATABASE_URL` carries the database
 * password and `SESSION_SECRET` is a secret. Once it is read, every component logs through one
 * logger that also redacts the database user name and password, where each stands as the
 * credential, from driver error text, and the driver's `PG*` variables are deleted, so that
 * `DATABASE_URL` alone decides how the pool connects.
 */

import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';

import { createApp } from './app';
import { createAuthService } from './auth/auth-service';
import { ConfigError, databaseCredentials, loadConfig, removePgVariables } from './config';
import type { AppConfig } from './config';
import { createDataAccess } from './db/data-access';
import { runMigrations } from './db/migrate';
import { createPool, POOL_MAX_CLIENTS } from './db/pool';
import { createPurgeJob } from './purge-job';
import type { PurgeJob } from './purge-job';
import { createReportService } from './reports/report-service';
import { systemClock } from './shared/clock';
import { createLogger } from './shared/logger';
import type { Logger } from './shared/logger';
import { createTaskService } from './tasks/task-service';

/** Interval between purges of expired sessions and old failed-login rows: 15 minutes. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/** Signals that start a graceful shutdown. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * libuv's own default thread-pool size, kept on top of one thread per pooled connection for the
 * thread pool's other work: `express.static` file reads, `dns.lookup` of a database host name and
 * the rest of Node's asynchronous file-system calls.
 */
const LIBUV_DEFAULT_THREADS = 4;

/** The process's pool, typed through its factory so that only the data-access layer imports pg. */
type Pool = ReturnType<typeof createPool>;

/**
 * An HTTP server with what each of its open connections still owes, recorded by
 * {@link trackConnections} from the moment the server is created, so that {@link closeServer}
 * can tell a connection that is answering a request from one that has no request to answer.
 */
interface TrackedServer {
  readonly server: http.Server;
  /**
   * Every socket the server accepted that is still open, with the responses on it that have not
   * closed yet: one per request, several when requests are pipelined.
   */
  readonly owed: Map<Socket, Set<http.ServerResponse>>;
  /** Set when {@link closeServer} begins; from then on a socket owing no answer is destroyed. */
  closing: boolean;
}

/** What a graceful shutdown stops, in the order it stops them. */
interface RunningServer {
  logger: Logger;
  purgeJob: PurgeJob;
  server: TrackedServer;
  pool: Pool;
}

/**
 * Starts listening on every interface and settles once the port is bound, or rejects with the
 * listen error, for example `EADDRINUSE` or `EACCES`.
 */
function listen(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

/**
 * Whether a connection owes an answer: one of its open responses belongs to a request received
 * in full, or has begun to be sent. A connection owes none when it has no request yet (no byte,
 * or headers still arriving), when its only requests are still receiving their body and nothing
 * has been sent for them, or when it is an idle keep-alive connection.
 */
function owesAnswer(responses: ReadonlySet<http.ServerResponse>): boolean {
  for (const res of responses) {
    if (res.req.complete || res.headersSent) {
      return true;
    }
  }
  return false;
}

/**
 * Starts recording every connection `server` accepts and the responses each one owes, for
 * {@link closeServer}. It must run before the server listens, so that no connection escapes it.
 * Once the server is closing, a connection is destroyed as soon as its last owed response closes,
 * so it carries no further request.
 */
function trackConnections(server: http.Server): TrackedServer {
  const tracked: TrackedServer = { server, owed: new Map(), closing: false };
  const track = (socket: Socket): Set<http.ServerResponse> => {
    const responses = new Set<http.ServerResponse>();
    tracked.owed.set(socket, responses);
    socket.once('close', (): void => {
      tracked.owed.delete(socket);
    });
    return responses;
  };
  server.on('connection', (socket: Socket): void => {
    track(socket);
  });
  // `request` fires once a request's headers are parsed, before its body arrives, and for each
  // pipelined request in turn; `close` fires once the response has released the socket.
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const socket = req.socket;
    const responses = tracked.owed.get(socket) ?? track(socket);
    responses.add(res);
    res.once('close', (): void => {
      responses.delete(res);
      if (tracked.closing && !owesAnswer(responses)) {
        socket.destroy();
      }
    });
  });
  return tracked;
}

/**
 * Stops accepting connections and settles once every open connection has closed. A connection
 * that owes no answer (see {@link owesAnswer}) is destroyed at once: one with no request yet, one
 * whose only requests are still sending their body, or an idle keep-alive one. Every other
 * connection is destroyed as soon as its last owed response closes, which it does once every
 * byte of it has been handed to the operating system. Requests received in full therefore finish,
 * and their responses are delivered in full before their connections close, a response that had
 * already ended but was still queued for a slow reader included. Nothing else bounds the wait: a
 * handler that never answers, or a client that stops reading, is left to the orchestrator's grace
 * period.
 */
function closeServer(tracked: TrackedServer): Promise<void> {
  const { server, owed } = tracked;
  return new Promise<void>((resolve, reject): void => {
    tracked.closing = true;
    // `net.Server#close` only stops listening. `http.Server#close` would first destroy every
    // connection Node counts as idle, which it does once a whole request has arrived, so it would
    // cut short a response that has ended but is still queued for a slow reader. The loop below
    // and the tracking close each connection instead. The HTTP server's header and request timeout
    // checker, which only `http.Server#close` stops, keeps running on its unref'd timer until the
    // process exits; it holds nothing open, so that is harmless.
    net.Server.prototype.close.call(server, (err?: Error): void => {
      if (err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
    // Stopping the listener ends no connection, so a connection with no byte, partial headers or
    // a partial body would hold the shutdown open until a timeout or the client ended it.
    for (const [socket, responses] of owed) {
      if (!owesAnswer(responses)) {
        socket.destroy();
      }
    }
  });
}

/**
 * Runs one log call, best effort. The logger leaves its output stream's `write` unguarded, and a
 * failed log write must never skip a cleanup step, reject {@link main} or a shutdown, or become an
 * unhandled rejection, so a call that throws is dropped and the exit code still reports the
 * outcome.
 */
function logBestEffort(write: () => void): void {
  try {
    write();
  } catch {
    // Dropped on purpose: the log output that just failed is the only channel there is to report
    // the failure on.
  }
}

/**
 * Ends the pool on a start-up failure path. A failure to end it is logged as `pool end failed`,
 * best effort, and never rethrown: the start-up failure is already logged and has set exit code
 * 1, and it stays the outcome the process reports.
 */
async function endPoolAfterFailure(pool: Pool, logger: Logger): Promise<void> {
  try {
    await pool.end();
  } catch (err) {
    logBestEffort(() => logger.error('pool end failed', err));
  }
}

/** What a start-up had created when it failed; `null` for each step it had not reached. */
interface StartedResources {
  purgeJob: PurgeJob | null;
  server: TrackedServer | null;
  pool: Pool | null;
}

/**
 * Releases what a start-up that failed after creating its resources had started, in shutdown
 * order: stops the purge job, closes the HTTP server if it is listening, then ends the pool. Each
 * step runs whatever the one before it did. A failure to stop the job or close the server is
 * logged as `startup failed`, and a failure to end the pool as `pool end failed`, both best
 * effort; none is rethrown, so the failed start-up stays the outcome the process reports.
 */
async function releaseAfterStartupFailure(
  started: StartedResources,
  logger: Logger,
): Promise<void> {
  const { purgeJob, server, pool } = started;
  if (purgeJob !== null) {
    try {
      purgeJob.stop();
    } catch (err) {
      logBestEffort(() => logger.error('startup failed', err));
    }
  }
  if (server !== null && server.server.listening) {
    try {
      await closeServer(server);
    } catch (err) {
      logBestEffort(() => logger.error('startup failed', err));
    }
  }
  if (pool !== null) {
    await endPoolAfterFailure(pool, logger);
  }
}

/**
 * Registers the `SIGTERM` and `SIGINT` handlers, each with `process.once`. The first signal logs
 * `shutting down` with the signal, then stops the purge job, closes the HTTP server and ends the
 * pool, and exits with code 0. Each of those three steps runs whatever the one before it did; any
 * failure is logged as `shutdown failed` and makes the exit code 1. Both lines are written best
 * effort, so a failed log write skips no step, and the shutdown calls `process.exit` exactly once,
 * after the last step. Closing the server destroys at once every connection that has no request
 * received in full to answer: no request yet, a body still arriving, or an idle keep-alive one.
 * Requests received in full finish first, and each of their connections closes as soon as its
 * responses have been delivered in full, a response that had already ended at the signal but was
 * still queued for a slow reader included (see {@link closeServer}).
 *
 * During a shutdown the other signal reaches the re-entry guard and is ignored, while a repeat of
 * the same signal force-stops a drain that hangs: it logs `shutdown failed`, best effort, with an
 * error naming the signal, and calls `process.exit(1)` at once. The exit is explicit, so a second
 * Ctrl+C or `SIGTERM` works whatever the process ID, PID 1 in a container included. Its listener
 * is removed before the shutdown's own exit, so a completed shutdown leaves no listener behind.
 * There is no hard-kill timer: the orchestrator's grace period bounds the shutdown.
 */
function handleShutdownSignals(running: RunningServer): void {
  const { logger, purgeJob, server, pool } = running;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // A repeat of the signal that began the shutdown ends the process with code 1. The exit is
    // explicit rather than left to Node's default action for a signal nobody listens to: the
    // kernel applies no default action to a signal sent to PID 1, which `node` is in a container
    // started without an init process.
    const forceStop = (): void => {
      logBestEffort(() =>
        logger.error('shutdown failed', new Error(`${signal} received again during the shutdown`)),
      );
      process.exit(1);
    };
    process.once(signal, forceStop);
    logBestEffort(() => logger.info('shutting down', { signal }));
    let failed = false;
    const fail = (err: unknown): void => {
      failed = true;
      logBestEffort(() => logger.error('shutdown failed', err));
    };
    try {
      purgeJob.stop();
    } catch (err) {
      fail(err);
    }
    try {
      await closeServer(server);
    } catch (err) {
      fail(err);
    }
    try {
      await pool.end();
    } catch (err) {
      fail(err);
    }
    process.removeListener(signal, forceStop);
    process.exit(failed ? 1 : 0);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, (received: NodeJS.Signals): void => {
      // `shutdown` handles every failure itself and ends in `process.exit`. This handler is the
      // last resort that still ends the process, with code 1, should it ever reject, so its
      // promise can never become an unhandled rejection.
      void shutdown(received).catch((): void => {
        process.exit(1);
      });
    });
  }
}

/**
 * Fixes libuv's thread-pool size at {@link POOL_MAX_CLIENTS} plus {@link LIBUV_DEFAULT_THREADS}
 * threads, 14, by setting `UV_THREADPOOL_SIZE`. The size is fixed, never read: a value inherited
 * from the environment is replaced, because the application reads no variables beyond its four
 * configuration variables. libuv reads the setting once, when its thread pool is first used, so
 * this runs before {@link main}; loading this file's modules does not use the thread pool.
 *
 * @param env The process environment, which libuv reads the setting from.
 */
function fixThreadPoolSize(env: NodeJS.ProcessEnv): void {
  // One thread per pooled connection: each login holds its connection for the length of the
  // bcrypt comparison it runs, and that comparison runs on libuv's thread pool, so logins for
  // different emails run in parallel up to the pool size. libuv's default 4 threads remain for
  // file reads and DNS lookups.
  env.UV_THREADPOOL_SIZE = String(POOL_MAX_CLIENTS + LIBUV_DEFAULT_THREADS);
}

/**
 * Starts the application. The steps run in this order, and each runs only when the one before
 * it succeeded:
 *
 * 1. Creates a JSON-lines logger on standard output that redacts nothing, for the configuration
 *    step alone: no connection string is known yet.
 * 2. Parses the environment with `loadConfig(process.env)`. An invalid variable logs the fixed
 *    configuration message alone, with no error object, and sets exit code 1.
 * 3. Creates the logger every later step and component uses, which replaces the user name and
 *    password of `DATABASE_URL`, where each stands as the credential, by `[redacted]` in each
 *    logged error's message and stack. Then it deletes every `PG*` variable from `process.env`,
 *    so the driver takes no connection setting from anything but `DATABASE_URL`, and creates the
 *    pool, which opens no connection yet.
 * 4. Applies every pending migration; the runner logs `migrations applied`. A failure, including
 *    an unreachable database, logs `migration failed`, ends the pool and sets exit code 1, so the
 *    server never accepts a request before the schema is current.
 * 5. Builds the data-access facade, the auth, task and report services on the system clock, the
 *    application and the purge job.
 * 6. Creates the HTTP server, which records from then on what each of its connections owes for
 *    the shutdown's drain, listens on `PORT` on every interface and logs `server listening` with
 *    the port. A listen failure such as `EADDRINUSE` logs `server failed to start`, ends the pool
 *    and sets exit code 1.
 * 7. Starts the purge job, which runs at once and then every 15 minutes, and last, once nothing
 *    is left that can fail, registers the `SIGTERM` and `SIGINT` handlers for a graceful
 *    shutdown.
 *
 * Any other failure during start-up logs `startup failed`, stops the purge job, closes the server
 * if it is listening, ends the pool if one was created and sets exit code 1, so a failed start-up
 * leaves no listening socket, purge timer or signal handler behind. That includes a failure to
 * write `server listening`: a process whose log output fails could report none of its later
 * failures, so that line is not best effort. Every failure and cleanup line is, so a log write
 * that throws never skips a cleanup step. Start-up failures set `process.exitCode` rather than
 * calling `process.exit()`, so the log lines are flushed before the process ends; the restart is
 * left to the orchestrator.
 *
 * @returns A promise that resolves once the server is listening with its shutdown handlers
 *   registered, or once a failed start-up has been logged and cleaned up; it never rejects.
 */
export async function main(): Promise<void> {
  // No URL is known before the configuration is read, so this first logger redacts nothing. It
  // serves only the fixed configuration message, which carries no error object, and a failure
  // to read the configuration at all.
  let logger: Logger = createLogger();
  // Each is set as soon as it exists, so that a failure after that point still releases it.
  let pool: Pool | null = null;
  let purgeJob: PurgeJob | null = null;
  let server: TrackedServer | null = null;
  try {
    let config: AppConfig;
    try {
      config = loadConfig(process.env);
    } catch (err) {
      if (!(err instanceof ConfigError)) {
        throw err;
      }
      // The fixed message alone: it never carries a received value, and no error object is passed.
      const message = err.message;
      logBestEffort(() => logger.error(message));
      process.exitCode = 1;
      return;
    }

    // Every later line goes through a logger that redacts the database password and user name,
    // which can be an email address, from driver error text, since PostgreSQL quotes the user
    // name in its own messages. Each is redacted only as the credential, so a path, a module or
    // a database name holding the same characters stays readable. The pool, the runner, the
    // application and the purge job log through it too.
    logger = createLogger(process.stdout, { redact: databaseCredentials(config.databaseUrl) });
    // The driver would otherwise take connection settings from any `PG*` variable, so
    // `DATABASE_URL` alone decides where and how every connection goes.
    removePgVariables(process.env);
    pool = createPool(config.databaseUrl, logger);

    try {
      await runMigrations(pool, logger);
    } catch (err) {
      logBestEffort(() => logger.error('migration failed', err));
      await endPoolAfterFailure(pool, logger);
      process.exitCode = 1;
      return;
    }

    const dal = createDataAccess(pool);
    const clock = systemClock;
    const auth = createAuthService({ dal, clock });
    const tasks = createTaskService({ dal, clock });
    const reports = createReportService({ dal, clock });
    const app = createApp({ config, clock, logger, auth, tasks, reports });
    // Constructed before listening, so its interval check is the last step that can fail while
    // no port is open yet; it is started only once the server listens.
    purgeJob = createPurgeJob({ auth, logger, intervalMs: PURGE_INTERVAL_MS });

    // Tracked before it listens, so the shutdown knows what every connection it accepts owes.
    server = trackConnections(http.createServer(app));
    try {
      await listen(server.server, config.port);
    } catch (err) {
      logBestEffort(() => logger.error('server failed to start', err));
      await endPoolAfterFailure(pool, logger);
      process.exitCode = 1;
      return;
    }
    // Not best effort: a failed write here is a start-up failure, handled below.
    logger.info('server listening', { port: config.port });

    purgeJob.start();
    handleShutdownSignals({ logger, purgeJob, server, pool });
  } catch (err) {
    logBestEffort(() => logger.error('startup failed', err));
    await releaseAfterStartupFailure({ purgeJob, server, pool }, logger);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  fixThreadPoolSize(process.env);
  // `main` logs, cleans up and resolves every start-up failure itself and never rejects; this
  // handler is the last resort that would still report exit code 1 should it ever do so.
  void main().catch((): void => {
    process.exitCode = 1;
  });
}

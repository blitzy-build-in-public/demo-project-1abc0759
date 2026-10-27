/**
 * Process entry point: `node dist/server.js` is the container command, `npm start`,
 * `npm run start:local` and the Playwright end-to-end web server.
 *
 * This is composition-root code. It reads the environment (with `src/db/migrate-cli.ts`, the only
 * file that does, passing it straight to `src/config.ts`), builds the pool, applies the pending
 * migrations, constructs the services and the application, listens, starts the scheduled purge,
 * and is the only file that handles signals. Importing it starts nothing: {@link main} runs only
 * when this file is the process entry.
 *
 * The configuration is never logged, whole or in part: `DATABASE_URL` carries the database
 * password and `SESSION_SECRET` is a secret. Once it is read, every component logs through one
 * logger that also redacts the database user name and password from driver error text.
 */

import http from 'node:http';

import { createApp } from './app';
import { createAuthService } from './auth/auth-service';
import { ConfigError, databaseCredentials, loadConfig } from './config';
import type { AppConfig } from './config';
import { createDataAccess } from './db/data-access';
import { runMigrations } from './db/migrate';
import { createPool } from './db/pool';
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

/** The process's pool, typed through its factory so that only the data-access layer imports pg. */
type Pool = ReturnType<typeof createPool>;

/** What a graceful shutdown stops, in the order it stops them. */
interface RunningServer {
  logger: Logger;
  purgeJob: PurgeJob;
  server: http.Server;
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
 * Stops accepting connections and settles once every open connection has closed: requests in
 * progress finish first, and idle keep-alive connections are closed at once.
 */
function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    server.close((err?: Error): void => {
      if (err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
    server.closeIdleConnections();
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
  server: http.Server | null;
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
  if (server !== null && server.listening) {
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
 * effort, so a failed log write skips no step, and `process.exit` is called exactly once, after
 * the last step. Requests in progress finish first, and their connections close as soon as they
 * have responded.
 *
 * During a shutdown the other signal reaches the re-entry guard and is ignored, while a repeat of
 * the same signal finds no listener left, so Node's default action ends the process at once: a
 * second Ctrl+C or `SIGTERM` force-stops a drain that hangs. There is no hard-kill timer: the
 * orchestrator's grace period bounds the shutdown.
 */
function handleShutdownSignals(running: RunningServer): void {
  const { logger, purgeJob, server, pool } = running;
  let shuttingDown = false;

  // `server.close` ends only the keep-alive connections idle at that moment. One still serving a
  // request would stay open for `keepAliveTimeout` after its response, and could carry further
  // requests, so during a shutdown each connection is ended as soon as its response completes.
  // The listener is attached here, before any signal, so that it also covers requests already in
  // progress when the shutdown begins; `close` fires once the response has released its socket.
  server.on('request', (_req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.once('close', (): void => {
      if (shuttingDown) {
        server.closeIdleConnections();
      }
    });
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
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
 * Starts the application. The steps run in this order, and each runs only when the one before
 * it succeeded:
 *
 * 1. Creates a JSON-lines logger on standard output that redacts nothing, for the configuration
 *    step alone: no connection string is known yet.
 * 2. Parses the environment with `loadConfig(process.env)`. An invalid variable logs the fixed
 *    configuration message alone, with no error object, and sets exit code 1.
 * 3. Creates the logger every later step and component uses, which replaces the user name and
 *    password of `DATABASE_URL` by `[redacted]` in each logged error's message and stack, then the
 *    pool, which opens no connection yet.
 * 4. Applies every pending migration; the runner logs `migrations applied`. A failure, including
 *    an unreachable database, logs `migration failed`, ends the pool and sets exit code 1, so the
 *    server never accepts a request before the schema is current.
 * 5. Builds the data-access facade, the auth, task and report services on the system clock, the
 *    application and the purge job.
 * 6. Listens on `PORT` on every interface and logs `server listening` with the port. A listen
 *    failure such as `EADDRINUSE` logs `server failed to start`, ends the pool and sets exit
 *    code 1.
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
  let server: http.Server | null = null;
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

    // Every later line goes through a logger that redacts the database user name, which can be
    // an email address, and password from driver error text, since PostgreSQL quotes the user
    // name in its own messages. The pool, the runner, the application and the purge job log
    // through it too.
    logger = createLogger(process.stdout, { redact: databaseCredentials(config.databaseUrl) });
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

    server = http.createServer(app);
    try {
      await listen(server, config.port);
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
  // `main` logs, cleans up and resolves every start-up failure itself and never rejects; this
  // handler is the last resort that would still report exit code 1 should it ever do so.
  void main().catch((): void => {
    process.exitCode = 1;
  });
}

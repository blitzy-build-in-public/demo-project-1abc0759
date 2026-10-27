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
 * password and `SESSION_SECRET` is a secret.
 */

import http from 'node:http';

import { createApp } from './app';
import { createAuthService } from './auth/auth-service';
import { ConfigError, loadConfig } from './config';
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
 * Ends the pool on a start-up failure path. A failure to end it is logged as `pool end failed`
 * and never rethrown: the start-up failure is already logged and has set exit code 1, and it
 * stays the outcome the process reports.
 */
async function endPoolAfterFailure(pool: Pool, logger: Logger): Promise<void> {
  try {
    await pool.end();
  } catch (err) {
    logger.error('pool end failed', err);
  }
}

/**
 * Registers the `SIGTERM` and `SIGINT` handlers. Either signal logs `shutting down` with the
 * signal, stops the purge job, closes the HTTP server, ends the pool and exits with code 0; a
 * failure while closing the server or ending the pool logs `shutdown failed` and exits with
 * code 1. Requests in progress finish first, and their connections close as soon as they have
 * responded. A second signal while a shutdown is in progress is ignored. There is no hard-kill
 * timer: the orchestrator's grace period bounds the shutdown.
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
    logger.info('shutting down', { signal });
    purgeJob.stop();
    try {
      await closeServer(server);
      await pool.end();
    } catch (err) {
      logger.error('shutdown failed', err);
      process.exit(1);
    }
    process.exit(0);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, (received: NodeJS.Signals): void => {
      void shutdown(received);
    });
  }
}

/**
 * Starts the application. The steps run in this order, and each runs only when the one before
 * it succeeded:
 *
 * 1. Creates the JSON-lines logger on standard output.
 * 2. Parses the environment with `loadConfig(process.env)`. An invalid variable logs the fixed
 *    configuration message alone, with no error object, and sets exit code 1.
 * 3. Creates the pool, which opens no connection yet.
 * 4. Applies every pending migration; the runner logs `migrations applied`. A failure, including
 *    an unreachable database, logs `migration failed`, ends the pool and sets exit code 1, so the
 *    server never accepts a request before the schema is current.
 * 5. Builds the data-access facade, the auth, task and report services on the system clock, the
 *    application and the purge job.
 * 6. Listens on `PORT` on every interface and logs `server listening` with the port. A listen
 *    failure such as `EADDRINUSE` logs `server failed to start`, ends the pool and sets exit
 *    code 1.
 * 7. Starts the purge job, which runs at once and then every 15 minutes, and registers the
 *    `SIGTERM` and `SIGINT` handlers for a graceful shutdown.
 *
 * Any other failure during start-up logs `startup failed`, ends the pool if one was created and
 * sets exit code 1. Start-up failures set `process.exitCode` rather than calling `process.exit()`,
 * so the log lines are flushed before the process ends; the restart is left to the orchestrator.
 *
 * @returns A promise that resolves once the server is listening or start-up has failed; it does
 *   not reject.
 */
export async function main(): Promise<void> {
  const logger = createLogger();
  // Set as soon as the pool exists, so that an unexpected failure after that point still ends it.
  let pool: Pool | null = null;
  try {
    let config: AppConfig;
    try {
      config = loadConfig(process.env);
    } catch (err) {
      if (!(err instanceof ConfigError)) {
        throw err;
      }
      // The fixed message alone: it never carries a received value, and no error object is passed.
      logger.error(err.message);
      process.exitCode = 1;
      return;
    }

    pool = createPool(config.databaseUrl, logger);

    try {
      await runMigrations(pool, logger);
    } catch (err) {
      logger.error('migration failed', err);
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
    const purgeJob = createPurgeJob({ auth, logger, intervalMs: PURGE_INTERVAL_MS });

    const server = http.createServer(app);
    try {
      await listen(server, config.port);
    } catch (err) {
      logger.error('server failed to start', err);
      await endPoolAfterFailure(pool, logger);
      process.exitCode = 1;
      return;
    }
    logger.info('server listening', { port: config.port });

    purgeJob.start();
    handleShutdownSignals({ logger, purgeJob, server, pool });
  } catch (err) {
    logger.error('startup failed', err);
    if (pool !== null) {
      await endPoolAfterFailure(pool, logger);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  // `main` logs and resolves every start-up failure itself; this handler covers only a failure of
  // that logging, so the exit code still reports it.
  void main().catch((): void => {
    process.exitCode = 1;
  });
}

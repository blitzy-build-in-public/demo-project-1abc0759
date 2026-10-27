import type { AuthService } from './auth/auth-service';
import type { Logger } from './shared/logger';

/** Largest delay Node's timers accept: 2^31 - 1 milliseconds, about 24.8 days. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Scheduled cleanup of expired sessions and old failed-login rows.
 *
 * `runOnce` never rejects: a failed purge is logged as `purge failed` and the next run retries.
 * Runs never overlap: a run requested while another is in progress is skipped.
 */
export interface PurgeJob {
  /**
   * Runs one purge and logs `purge completed` with the deleted counts. Resolves without
   * purging when a run is already in progress.
   *
   * @returns A promise that always resolves, whether the purge succeeded or failed.
   */
  runOnce(): Promise<void>;

  /**
   * Runs a purge immediately and then on every interval. Does nothing while already started.
   */
  start(): void;

  /**
   * Cancels the interval. Does nothing when not started. A run already in progress is not
   * awaited and completes on its own.
   */
  stop(): void;
}

/** What {@link createPurgeJob} needs. */
export interface PurgeJobDeps {
  /** The auth service, of which the job only calls `purgeExpired`. */
  auth: Pick<AuthService, 'purgeExpired'>;
  /** Receives `purge completed` and `purge failed`. */
  logger: Logger;
  /** Milliseconds between runs: an integer from 1 to 2,147,483,647. */
  intervalMs: number;
}

/**
 * Creates the purge job. Nothing runs until {@link PurgeJob.start} or {@link PurgeJob.runOnce}
 * is called.
 *
 * The interval timer is unref'd, so the job alone never keeps the process alive.
 *
 * @param deps - The auth service, the logger and the interval between runs.
 * @returns The job; all of its state lives in this closure.
 * @throws RangeError when `intervalMs` is not an integer from 1 to 2,147,483,647.
 */
export function createPurgeJob(deps: PurgeJobDeps): PurgeJob {
  const { auth, logger, intervalMs } = deps;

  // Node silently turns a non-numeric, sub-1 or over-limit delay into 1 ms, which would purge
  // continuously instead of failing.
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`intervalMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`);
  }

  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const counts = await auth.purgeExpired();
      logger.info('purge completed', {
        sessions: counts.sessions,
        loginAttempts: counts.loginAttempts,
      });
    } catch (err) {
      // A purge failure is logged and never thrown, so neither the timer nor the process stops;
      // the next tick retries and succeeds once the database is reachable again.
      try {
        logger.error('purge failed', err);
      } catch {
        // The logger is the only channel left to report on; a failure to write is dropped so
        // that this promise still resolves instead of becoming an unhandled rejection.
      }
    } finally {
      running = false;
    }
  };

  return {
    runOnce,

    start(): void {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref();
      void runOnce();
    },

    stop(): void {
      if (timer === null) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
  };
}

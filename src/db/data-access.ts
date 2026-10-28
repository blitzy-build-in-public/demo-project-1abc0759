/**
 * The data-access facade: the single object the auth, task and report modules receive from the
 * data-access layer.
 *
 * Its top-level repositories run each statement on the pool. `transaction` and `withLoginLock`
 * build the same four repositories on one checked-out client, so every statement the work issues
 * joins one transaction. Rollback, client release and the mapping of connection failures to
 * `DatabaseUnavailableError` all belong to `withTransaction` in `./query`.
 *
 * The facade's one piece of state is the queue of `withLoginLock` calls waiting for an email that
 * a call of the same facade is already using. The only error raised here is the
 * `DatabaseUnavailableError` a queued call rejects with when the call ahead of it met a
 * connection failure. Every error still reaches the caller that started the call; none is
 * swallowed.
 */

import type { Pool } from 'pg';

import { DatabaseUnavailableError } from '../shared/errors';
import { isConnectionFailure, query, withTransaction } from './query';
import type { Queryable } from './query';
import { createLoginAttemptsRepo } from './login-attempts-repo';
import type { LoginAttemptsRepo } from './login-attempts-repo';
import { createSessionsRepo } from './sessions-repo';
import type { SessionsRepo } from './sessions-repo';
import { createTasksRepo } from './tasks-repo';
import type { TasksRepo } from './tasks-repo';
import { createUsersRepo } from './users-repo';
import type { UsersRepo } from './users-repo';

/**
 * Serialises login attempts per normalised email for the rest of the transaction.
 *
 * `hashtextextended` yields one 64-bit key, the single-key form of the advisory lock. PostgreSQL
 * keeps that key space apart from the two-int4 form the migration runner locks with `(7253, 1)`,
 * so the two can never block each other. The `login:` prefix keeps the key specific to this use.
 */
const LOGIN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('login:' || $1::text, 0))`;

/**
 * How a `withLoginLock` call ended, as the next call queued for the same email reads it. Only a
 * connection failure changes what that call does, so any other ending is `{ unavailable: false }`.
 */
type LoginTurnEnd =
  | { readonly unavailable: false }
  | { readonly unavailable: true; readonly cause: unknown };

/** The ending of a call that resolved, or that failed for any reason but the connection. */
const TURN_CLEAR: LoginTurnEnd = { unavailable: false };

/**
 * Reads a failed call's error as the next same-email call sees it. A connection failure passes on
 * its root driver error, the `cause` of a `DatabaseUnavailableError`, so the errors of the calls
 * that fail behind it each wrap that driver error once rather than nesting one level per call.
 */
function turnEndAfter(err: unknown): LoginTurnEnd {
  if (!isConnectionFailure(err)) {
    return TURN_CLEAR;
  }
  const rootCause =
    err instanceof DatabaseUnavailableError && err.cause !== undefined ? err.cause : err;
  return { unavailable: true, cause: rootCause };
}

/** The four repositories, bound either to the pool or to one transaction's client. */
export interface TxRepos {
  /** Accounts: creation and the credential lookup. */
  users: UsersRepo;
  /** Server-side session records. */
  sessions: SessionsRepo;
  /** Failed-login records for the lockout. */
  loginAttempts: LoginAttemptsRepo;
  /** Owner-scoped task rows and the report aggregates. */
  tasks: TasksRepo;
}

/**
 * Everything the domain modules may do with the database.
 *
 * The inherited repositories run on the pool, one checked-out connection per statement, with no
 * transaction spanning two statements.
 */
export interface DataAccess extends TxRepos {
  /**
   * Runs `work` in one transaction: one client, `BEGIN`, every repository in `tx` on that
   * client, then `COMMIT`. When `work` or the commit fails, the transaction is rolled back and
   * the error rethrown; the client is always released.
   *
   * A failed statement aborts the whole transaction in PostgreSQL, so `work` must let a
   * statement error propagate rather than catch it and issue further statements on `tx`.
   * Row locks such as `tx.tasks.findById(..., { forUpdate: true })` last until the transaction
   * ends.
   *
   * @typeParam T - What the work resolves to.
   * @param work - The statements to run, through `tx` only.
   * @returns The value `work` resolved to, once the transaction has committed.
   * @throws `DatabaseUnavailableError` when the database cannot be reached; otherwise whatever
   *   `work`, `BEGIN` or `COMMIT` threw.
   */
  transaction<T>(work: (tx: TxRepos) => Promise<T>): Promise<T>;

  /**
   * Runs `work` in one transaction that first takes the login lock for `normalizedEmail`, so that
   * the lockout check, the credential check and the resulting write happen as one serial step
   * per email.
   *
   * - The lock is the first statement after `BEGIN`:
   *   `pg_advisory_xact_lock(hashtextextended('login:' || email, 0))`, a single 64-bit key derived
   *   from the email. Emails with no account are serialised exactly like registered ones.
   * - Commit or rollback releases it. It lives in PostgreSQL, so it serialises attempts within one
   *   process and across replicas alike.
   * - Two emails whose keys collide are merely serialised together, which costs time but not
   *   correctness.
   * - Calls of this facade for the same `normalizedEmail` also queue in this process, in arrival
   *   order, before they check out a client. A queued call holds no connection while it waits, so
   *   each call holds one pooled connection only for its own transaction, which for a login is
   *   one cost-12 bcrypt comparison. A burst of logins for one email therefore occupies one
   *   connection, and calls for different emails run in parallel up to the pool's `max` of 10.
   * - When a call fails with a connection failure, every call queued behind it for that email
   *   rejects at once with a `DatabaseUnavailableError` whose `cause` is the same driver error,
   *   without checking out a client or running its `work`. An unreachable database therefore
   *   fails a queue of logins together rather than one connection timeout after another. Any
   *   other ending, success or another error, lets the next queued call run.
   *
   * @typeParam T - What the work resolves to.
   * @param normalizedEmail - The key `normalizeEmail` produced: trimmed and lower-cased. It must be
   *   the same key the work passes to `tx.loginAttempts`.
   * @param work - The statements to run, through `tx` only, while the lock is held.
   * @returns The value `work` resolved to, once the transaction has committed.
   * @throws `DatabaseUnavailableError` when the database cannot be reached, including when the
   *   call queued ahead of this one for the same email could not reach it; otherwise whatever
   *   the lock statement, `work`, `BEGIN` or `COMMIT` threw.
   */
  withLoginLock<T>(normalizedEmail: string, work: (tx: TxRepos) => Promise<T>): Promise<T>;
}

/** Builds all four repositories on `db`, so their statements run wherever `db` runs them. */
function buildRepos(db: Queryable): TxRepos {
  return {
    users: createUsersRepo(db),
    sessions: createSessionsRepo(db),
    loginAttempts: createLoginAttemptsRepo(db),
    tasks: createTasksRepo(db),
  };
}

/**
 * Creates the data-access facade over a pool.
 *
 * @param pool - The process's pool, from `createPool`. The facade never ends it.
 * @returns The facade. Beyond `pool` it holds only the queue of its own pending `withLoginLock`
 *   calls, one entry per email with a call in progress, removed when that email's last call ends.
 */
export function createDataAccess(pool: Pool): DataAccess {
  // The ending of the newest `withLoginLock` call per email, which the next call for that email
  // awaits. Same-email calls would otherwise each check a client out and then block in
  // `pg_advisory_xact_lock`, so one account's burst of logins could take every pooled client.
  // These promises never reject.
  const loginQueue = new Map<string, Promise<LoginTurnEnd>>();

  /** One login transaction: the advisory lock as its first statement, then `work`. */
  function runLocked<T>(normalizedEmail: string, work: (tx: TxRepos) => Promise<T>): Promise<T> {
    return withTransaction(pool, async (client) => {
      await query(client, LOGIN_LOCK_SQL, [normalizedEmail]);
      return work(buildRepos(client));
    });
  }

  return {
    ...buildRepos(pool),

    transaction<T>(work: (tx: TxRepos) => Promise<T>): Promise<T> {
      return withTransaction(pool, (client) => work(buildRepos(client)));
    },

    withLoginLock<T>(normalizedEmail: string, work: (tx: TxRepos) => Promise<T>): Promise<T> {
      const ahead = loginQueue.get(normalizedEmail);
      const call = (async (): Promise<T> => {
        if (ahead !== undefined) {
          const aheadEnd = await ahead;
          if (aheadEnd.unavailable) {
            throw new DatabaseUnavailableError('Database unavailable', { cause: aheadEnd.cause });
          }
        }
        return runLocked(normalizedEmail, work);
      })();
      // The caller receives `call` itself, so its rejection still reaches the caller; `turn`
      // only records how it ended for the next call.
      const turn = call.then(() => TURN_CLEAR, turnEndAfter);
      loginQueue.set(normalizedEmail, turn);
      void turn.then(() => {
        if (loginQueue.get(normalizedEmail) === turn) {
          loginQueue.delete(normalizedEmail);
        }
      });
      return call;
    },
  };
}

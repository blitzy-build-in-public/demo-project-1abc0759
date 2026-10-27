/**
 * SQL execution for the data-access layer: the single place where driver errors that mean the
 * database cannot be reached become {@link DatabaseUnavailableError}, which the error handler
 * logs and renders as 503 "Service temporarily unavailable".
 *
 * Every other driver error (a constraint violation such as `23505`, a check violation, a syntax
 * error) is rethrown unchanged, with its `code` and `constraint` intact, so repositories can
 * still map expected outcomes such as a duplicate email. Nothing here logs, and no message built
 * here carries SQL text, bound values or the connection string.
 *
 * A client checked out here keeps an `error` listener for as long as it is out, so a connection
 * the server ends under it cannot crash the process. The first error it emits is kept on the
 * client and becomes the `cause` when pg then refuses the client's statements as not queryable,
 * and its connection is destroyed on release rather than returned to the pool.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import { DatabaseUnavailableError } from '../shared/errors';

/** Anything SQL can run on: the pool, or one checked-out client inside a transaction. */
export type Queryable = Pool | PoolClient;

/** Node network error codes for an unreachable host or a dropped socket. */
const NETWORK_ERROR_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
];

/** SQLSTATE class `08`, connection exception: five characters, digits or upper-case letters. */
const CONNECTION_EXCEPTION_SQLSTATE = /^08[0-9A-Z]{3}$/;

/** `admin_shutdown`, `crash_shutdown`, `cannot_connect_now` and `too_many_connections`. */
const UNAVAILABLE_SQLSTATES: readonly string[] = ['57P01', '57P02', '57P03', '53300'];

/** pg-pool's rejection when `connectionTimeoutMillis` passes while waiting for a client. */
const POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/**
 * pg's prefix for a socket that closed under a client: "Connection terminated",
 * "Connection terminated unexpectedly" and pg-pool's "Connection terminated due to connection
 * timeout".
 */
const CONNECTION_TERMINATED_PREFIX = 'Connection terminated';

/**
 * pg's rejections of a statement issued on a client that can no longer reach the server: its
 * socket already failed (and the client emitted `error`), or the client was ended. They follow
 * the driver error that broke the connection rather than carry it, so only their exact text
 * identifies them.
 */
const NOT_QUERYABLE_MESSAGES: readonly string[] = [
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
];

/**
 * Key under which a client from {@link checkOut} carries the first error it emitted while checked
 * out. The error lives on the client itself, so this module keeps no state of its own.
 */
const RECORDED_CONNECTION_ERROR: unique symbol = Symbol('recordedConnectionError');

/** A client from {@link checkOut}, which may carry the connection error it emitted. */
type TrackedClient = PoolClient & { [RECORDED_CONNECTION_ERROR]?: Error };

/**
 * How many levels of `cause` and `errors` are searched below the thrown value. Node 20 tries
 * IPv6 and IPv4 for `localhost` and reports an `AggregateError` whose entries hold the real
 * codes, and pg-pool wraps its timeout around the socket error, so a short chain must be
 * followed. The limit also ends the walk on a cyclic `cause` chain.
 */
const MAX_NESTING_DEPTH = 3;

/** Returns `source.code` when it is a string. */
function readCode(source: object): string | undefined {
  return 'code' in source && typeof source.code === 'string' ? source.code : undefined;
}

/** Returns `source.message` when it is a string. */
function readMessage(source: object): string | undefined {
  return 'message' in source && typeof source.message === 'string' ? source.message : undefined;
}

/** True for a Node network code or a SQLSTATE that means the server cannot serve the request. */
function isConnectionFailureCode(code: string): boolean {
  return (
    NETWORK_ERROR_CODES.includes(code) ||
    CONNECTION_EXCEPTION_SQLSTATE.test(code) ||
    UNAVAILABLE_SQLSTATES.includes(code)
  );
}

/**
 * True for the pool connect timeout, a terminated connection, and pg's refusal to run a statement
 * on a client whose connection is already gone.
 */
function isConnectionFailureMessage(message: string): boolean {
  return (
    message.includes(POOL_CONNECT_TIMEOUT_MESSAGE) ||
    message.startsWith(CONNECTION_TERMINATED_PREFIX) ||
    NOT_QUERYABLE_MESSAGES.includes(message)
  );
}

/** {@link isConnectionFailure} at `depth` levels below the thrown value. */
function matchesConnectionFailure(err: unknown, depth: number): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if (err instanceof DatabaseUnavailableError) {
    return true;
  }
  const code = readCode(err);
  if (code !== undefined && isConnectionFailureCode(code)) {
    return true;
  }
  const message = readMessage(err);
  if (message !== undefined && isConnectionFailureMessage(message)) {
    return true;
  }
  if (depth >= MAX_NESTING_DEPTH) {
    return false;
  }
  if (
    'errors' in err &&
    Array.isArray(err.errors) &&
    err.errors.some((inner: unknown) => matchesConnectionFailure(inner, depth + 1))
  ) {
    return true;
  }
  return 'cause' in err && matchesConnectionFailure(err.cause, depth + 1);
}

/**
 * Tells whether a thrown value means the database could not be reached or dropped the
 * connection, as opposed to rejecting the statement.
 *
 * True when the value, or an entry of its `errors` array or its `cause` (followed a few levels
 * deep), has one of these:
 * - `code` `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT` or `EAI_AGAIN`;
 * - `code` a SQLSTATE of class `08`, or `57P01`, `57P02`, `57P03` or `53300`;
 * - a `message` containing "timeout exceeded when trying to connect";
 * - a `message` starting with "Connection terminated";
 * - the `message` "Client has encountered a connection error and is not queryable" or "Client
 *   was closed and is not queryable", pg's rejection of a statement on a dead client.
 *
 * A {@link DatabaseUnavailableError} is always a connection failure. Statement errors such as
 * `23505` are not.
 *
 * @param err - Any thrown value.
 * @returns Whether the failure belongs to the connection rather than to the SQL.
 */
export function isConnectionFailure(err: unknown): boolean {
  return matchesConnectionFailure(err, 0);
}

/**
 * Wraps a connection failure in {@link DatabaseUnavailableError}, keeping the driver error as
 * `cause`, and returns every other value unchanged. An error that is already a
 * `DatabaseUnavailableError` is returned as is, so nested helpers never wrap twice.
 *
 * When `err` is pg's follow-on "not queryable" rejection and `db` is a client from
 * {@link checkOut} that emitted an error, that emitted error becomes the `cause` instead: it is
 * the driver error (`57P01`, "Connection terminated unexpectedly") that the follow-on only
 * reports second-hand.
 */
function toDatabaseError(err: unknown, db?: Queryable): unknown {
  if (err instanceof DatabaseUnavailableError || !isConnectionFailure(err)) {
    return err;
  }
  const recorded = db === undefined ? undefined : recordedConnectionError(db);
  const cause = recorded !== undefined && isNotQueryableError(err) ? recorded : err;
  return new DatabaseUnavailableError('Database unavailable', { cause });
}

/** The first error a client from {@link checkOut} emitted while checked out, if any. */
function recordedConnectionError(db: Queryable): unknown {
  return RECORDED_CONNECTION_ERROR in db ? db[RECORDED_CONNECTION_ERROR] : undefined;
}

/** True for pg's own refusal to run a statement on a client that is no longer queryable. */
function isNotQueryableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const message = readMessage(err);
  return message !== undefined && NOT_QUERYABLE_MESSAGES.includes(message);
}

/**
 * Runs one SQL string with positional parameters (`$1`, `$2`, …) and returns its rows.
 *
 * With no parameters pg uses the simple-query protocol, which accepts several statements in one
 * string. The migration runner relies on that to run whole migration files. For such a string
 * the rows of every statement are returned, in statement order.
 *
 * @typeParam R - Row shape the caller's SQL selects. Columns arrive under their SQL names, and
 *   the caller maps them to its record type.
 * @param db - The pool, or a client checked out for a transaction.
 * @param sql - Parameterised SQL text; values are never interpolated into it.
 * @param params - Values bound to `$1`, `$2`, … in order.
 * @returns The returned rows, empty for statements that return none.
 * @throws {@link DatabaseUnavailableError} when the database cannot be reached; any other driver
 *   error unchanged.
 */
export async function query<R>(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
): Promise<R[]> {
  const values = [...params];
  // pg resolves a multi-statement simple query with one result per statement, which its type
  // declarations do not express.
  let outcome: QueryResult<QueryResultRow> | QueryResult<QueryResultRow>[];
  try {
    outcome = await db.query<QueryResultRow>(sql, values);
  } catch (err) {
    throw toDatabaseError(err, db);
  }
  const rows = Array.isArray(outcome) ? outcome.flatMap((result) => result.rows) : outcome.rows;
  // The one place untyped driver rows take the caller's row type.
  return rows as R[];
}

/**
 * Gives a freshly checked-out client its `error` listener and a `release` that takes the
 * listener off again. pg-pool assigns the client a new `release` at every checkout, so the
 * wrapper belongs to this checkout alone.
 */
function trackConnectionErrors(client: PoolClient): PoolClient {
  const tracked: TrackedClient = client;
  // pg-pool removes its idle-client listener while a client is checked out, and an `error` event
  // with no listener would end the process. pg can emit more than once for one failure (the
  // server's error, then the socket's end), so only the first, which names the cause, is kept.
  // Nothing is rethrown or logged: the next statement on the client reports the failure.
  const recordError = (err: Error): void => {
    if (tracked[RECORDED_CONNECTION_ERROR] === undefined) {
      tracked[RECORDED_CONNECTION_ERROR] = err;
    }
  };
  const poolRelease = client.release;
  client.on('error', recordError);
  client.release = (...args: Parameters<PoolClient['release']>): void => {
    const failed = tracked[RECORDED_CONNECTION_ERROR] !== undefined;
    client.removeListener('error', recordError);
    delete tracked[RECORDED_CONNECTION_ERROR];
    if (failed && !args[0]) {
      // A connection that failed must not go back to the pool, so it is destroyed.
      poolRelease.call(client, true);
    } else {
      poolRelease.call(client, ...args);
    }
  };
  return client;
}

/**
 * Checks one client out of `pool`, for statements that must share a database session.
 *
 * While the client is out it carries an `error` listener, so a connection the server ends (a
 * restart, `pg_terminate_backend`) cannot crash the process with an unhandled `error` event. The
 * listener keeps the first error the client emits and neither rethrows nor logs it. The next
 * statement on the client through {@link query} raises {@link DatabaseUnavailableError} with that
 * error as `cause`.
 *
 * The caller still releases the client exactly once, and that release removes the listener. A
 * client that emitted an error is destroyed: a missing or falsy argument becomes `release(true)`.
 * Any other release passes the caller's arguments to pg-pool unchanged. A second release throws,
 * as pg-pool's does.
 *
 * @param pool - The pool to check a client out of.
 * @returns The client; the caller releases it exactly once.
 * @throws {@link DatabaseUnavailableError} when the database cannot be reached; any other
 *   failure to connect unchanged.
 */
export async function checkOut(pool: Pool): Promise<PoolClient> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw toDatabaseError(err);
  }
  return trackConnectionErrors(client);
}

/** Issues `ROLLBACK` and reports whether it succeeded. Its own failure is never rethrown. */
async function rollBack(client: PoolClient): Promise<boolean> {
  try {
    await query(client, 'ROLLBACK', []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `work` inside one transaction on one checked-out client: `BEGIN`, the work, `COMMIT`.
 *
 * When any step fails, `ROLLBACK` is attempted and the original error is rethrown, mapped to
 * {@link DatabaseUnavailableError} when it is a connection failure. A failed rollback is never
 * reported in its place. The client is released exactly once. Its connection is destroyed
 * instead of returned to the pool when the failure was a connection failure or the rollback
 * failed, because the connection may still hold an open transaction or a dead socket.
 *
 * @typeParam T - What the work resolves to.
 * @param pool - The pool to check a client out of.
 * @param work - Statements to run on the client. It must not release the client.
 * @returns The value `work` resolved to, once the transaction has committed.
 * @throws {@link DatabaseUnavailableError} when the database cannot be reached; otherwise
 *   whatever `work`, `BEGIN` or `COMMIT` threw.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await checkOut(pool);
  let destroyConnection = false;
  try {
    await query(client, 'BEGIN', []);
    const result = await work(client);
    await query(client, 'COMMIT', []);
    return result;
  } catch (err) {
    const mapped = toDatabaseError(err, client);
    const rolledBack = await rollBack(client);
    destroyConnection = !rolledBack || isConnectionFailure(mapped);
    throw mapped;
  } finally {
    if (destroyConnection) {
      client.release(true);
    } else {
      client.release();
    }
  }
}

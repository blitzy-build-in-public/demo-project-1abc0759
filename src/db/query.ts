/**
 * SQL execution for the data-access layer: the single place where driver errors that mean the
 * database cannot be reached become {@link DatabaseUnavailableError}, which the error handler
 * logs and renders as 503 "Service temporarily unavailable".
 *
 * Every other driver error (a constraint violation such as `23505`, a check violation, a syntax
 * error) is rethrown unchanged, with its `code` and `constraint` intact, so repositories can
 * still map expected outcomes such as a duplicate email. Nothing here logs, and no message built
 * here carries SQL text, bound values or the connection string.
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

/** True for the pool connect timeout and for a terminated connection. */
function isConnectionFailureMessage(message: string): boolean {
  return (
    message.includes(POOL_CONNECT_TIMEOUT_MESSAGE) ||
    message.startsWith(CONNECTION_TERMINATED_PREFIX)
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
 * - a `message` starting with "Connection terminated".
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
 */
function toDatabaseError(err: unknown): unknown {
  if (err instanceof DatabaseUnavailableError || !isConnectionFailure(err)) {
    return err;
  }
  return new DatabaseUnavailableError('Database unavailable', { cause: err });
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
    throw toDatabaseError(err);
  }
  const rows = Array.isArray(outcome) ? outcome.flatMap((result) => result.rows) : outcome.rows;
  // The one place untyped driver rows take the caller's row type.
  return rows as R[];
}

/**
 * Checks one client out of `pool`, for statements that must share a database session.
 *
 * @param pool - The pool to check a client out of.
 * @returns The client; the caller releases it exactly once.
 * @throws {@link DatabaseUnavailableError} when the database cannot be reached; any other
 *   failure to connect unchanged.
 */
export async function checkOut(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err) {
    throw toDatabaseError(err);
  }
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
    const mapped = toDatabaseError(err);
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

/**
 * PostgreSQL connection pool: the one place that configures how `pg` connects and how it
 * converts values in both directions.
 *
 * Importing this module registers the driver's global type parsers once, for every pool in the
 * process. That registration and the logger's output stream are the application's only
 * module-level state; the pool itself is constructed by the entry points and the test helpers.
 */

import pg from 'pg';
import type { Pool } from 'pg';

import type { Logger } from '../shared/logger';

// DATE (OID 1082) stays the `YYYY-MM-DD` text PostgreSQL sends. The default parser builds a
// JavaScript `Date` at local midnight, which lands on another UTC day on any host outside UTC;
// due dates and report days are `IsoDate` strings throughout the application.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string): string => value);

// INT8 (OID 20) becomes a `number` instead of the default string. Identity ids and `count(*)`
// results stay far below 2^53, and task ids accepted from requests are at most 15 digits.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string): number => Number(value));

// `Date` parameters serialise as UTC instants whatever the process time zone. TIMESTAMPTZ results
// keep the default parser, which already yields a `Date` for the absolute instant.
pg.defaults.parseInputDatesAsUTC = true;

/** Upper bound on open connections per process. */
const POOL_MAX_CLIENTS = 10;

/** How long a checkout waits for a connection before failing as database-unavailable. */
const CONNECTION_TIMEOUT_MS = 5_000;

/** How long an unused connection stays open before the pool closes it. */
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Start-up parameter that sets the session time zone on every connection, so server-side casts,
 * `to_char` and `AT TIME ZONE` produce UTC days, which the report ranges and groupings rely on.
 */
const SESSION_OPTIONS = '-c TimeZone=UTC';

/**
 * Creates the process's PostgreSQL pool.
 *
 * Settings: at most 10 connections, a 5-second connection timeout, a 30-second idle timeout,
 * and the session time zone fixed to UTC through the `TimeZone` start-up parameter. Together
 * with the type parsers registered by this module, DATE values arrive as `YYYY-MM-DD` text, INT8
 * values as numbers, and `Date` parameters are sent in UTC.
 *
 * No connection is opened until the first query or checkout, and the connection string is never
 * logged, because it carries the database password.
 *
 * An `error` listener is attached before the pool is returned: an idle client that fails, for
 * example when the database restarts, is logged as `idle client error` rather than raised as an
 * unhandled `error` event that would end the process. The pool replaces that client on demand.
 *
 * @param databaseUrl `postgres://` or `postgresql://` connection string, validated by the caller.
 * @param logger Receives idle-client failures.
 * @returns A new pool; the caller owns it and ends it at shutdown.
 */
export function createPool(databaseUrl: string, logger: Logger): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: POOL_MAX_CLIENTS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    options: SESSION_OPTIONS,
  });

  pool.on('error', (err: Error): void => {
    logger.error('idle client error', err);
  });

  return pool;
}

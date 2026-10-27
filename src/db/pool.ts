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
 * How `pg` reports the outcome of `Client.connect(callback)`: the error alone on failure, or
 * `null` and the connected client on success.
 */
type ConnectOutcome = [err: Error] | [err: null, client: pg.Client];

/** The callback form of `connect`, called once with the {@link ConnectOutcome}. */
type ConnectCallback = (...outcome: ConnectOutcome) => void;

/**
 * The client class every pool creates: a `pg.Client` that closes its socket when its connection
 * attempt fails.
 *
 * `pg` rejects some connection attempts on the client side, for example when SCRAM
 * authentication asks for a password the connection string does not carry. It reports the error
 * but leaves the socket open, and pg-pool drops such a client without closing it. The server then
 * keeps that backend waiting for the rest of the handshake until its `authentication_timeout`
 * (one minute by default), and the open socket keeps the process alive just as long, so a CLI
 * run or a failed start-up would exit only after that minute. Here the socket of a failed attempt
 * is destroyed before the error is reported, as pg-pool itself does after its connection timeout.
 *
 * The socket is destroyed rather than ended: ending it would send a Terminate message in the
 * middle of authentication, which the server logs as a protocol violation, while destroying it
 * gives the server a plain end of file. The client has already recorded the connection error, so
 * the closed socket raises no further `error` event. Only the first `connect` call owns the
 * socket: a later call fails with pg's reuse error while the first call's socket may be live, so
 * it is left untouched.
 */
class TeardownOnFailureClient extends pg.Client {
  /** Set by the first `connect` call, the only one whose failure closes the socket. */
  private connectCalled = false;

  /**
   * Connects to the server, destroying the socket when the first attempt fails.
   *
   * @returns This client once it is ready for queries; rejects with pg's original error.
   */
  override connect(): Promise<pg.Client>;

  /**
   * Connects to the server, destroying the socket when the first attempt fails.
   *
   * @param callback Receives pg's original error, or `null` and this client once it is ready.
   */
  override connect(callback: ConnectCallback): void;

  override connect(callback?: ConnectCallback): Promise<pg.Client> | void {
    if (callback === undefined) {
      // One code path for both forms: the promise settles from the callback form below.
      return new Promise<pg.Client>((resolve, reject): void => {
        this.connect((...outcome: ConnectOutcome): void => {
          if (outcome[0] === null) {
            resolve(outcome[1]);
          } else {
            reject(outcome[0]);
          }
        });
      });
    }

    const ownsSocket = !this.connectCalled;
    this.connectCalled = true;
    super.connect((...outcome: ConnectOutcome): void => {
      if (ownsSocket && outcome[0] !== null) {
        this.connection.stream.destroy();
      }
      callback(...outcome);
    });
  }
}

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
 * A connection attempt that fails closes its socket at once, including one `pg` rejects itself,
 * such as SCRAM authentication with no password. The failure therefore reaches the caller within
 * the connection timeout, and neither the process nor a server backend waits on the abandoned
 * socket until the server's authentication timeout.
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
    Client: TeardownOnFailureClient,
  });

  pool.on('error', (err: Error): void => {
    logger.error('idle client error', err);
  });

  return pool;
}

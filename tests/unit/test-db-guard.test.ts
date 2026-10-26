/**
 * Unit tests for `assertTestDatabaseUrl`, the guard both global setups run before they migrate
 * the database `DATABASE_URL` names, and before the end-to-end setup truncates it.
 *
 * `pg` takes a `socket:` URL's database from its `db` query parameter rather than the path, so a
 * guard that read only the path would let `socket:/some_pg_socket_test?db=tasktracker` reach the
 * development database. The guard therefore refuses every scheme but `postgres:` and
 * `postgresql:` before it checks that the name ends in `_test`.
 *
 * `pg` also re-encodes a connection string holding a raw space or a malformed percent-escape
 * before it reads the database, so `postgres://user:pass word@localhost/tasks%5Ftest`, whose path
 * decodes to `tasks_test`, connects to `tasks%5Ftest`. The guard therefore refuses every such
 * string, and each URL it accepts is also resolved by `pg`'s own parser to confirm that the
 * database `pg` would use ends in `_test`.
 *
 * The guard only parses its input, and constructing a `pg.Client` only parses its connection
 * string, so no case here opens a connection or needs a database.
 */

import pg from 'pg';

import { assertTestDatabaseUrl } from '../helpers/test-db';

/** The guard's message for any URL that is not `postgres://` or `postgresql://`. */
const PROTOCOL_MESSAGE = 'DATABASE_URL must be a postgres:// connection string';

/** The guard's message for any URL holding a raw space or a malformed percent-escape. */
const REWRITE_MESSAGE =
  'DATABASE_URL must not contain a raw space or a malformed percent-escape; ' +
  'encode them as %20 and %25';

/** Password carried by the credential-bearing cases; no guard message may echo it. */
const PASSWORD = 'secret';

/**
 * A URL whose path decodes to `tasks_test`, while its raw space makes `pg` re-encode it and
 * connect to `tasks%5Ftest` instead.
 */
const REWRITTEN_TARGET_URL = 'postgres://user:pass word@localhost/tasks%5Ftest';

/** URLs the guard accepts and returns unchanged; `pg` must resolve each to a `_test` database. */
const ACCEPTED_URLS: readonly string[] = [
  'postgres://tasktracker:x@127.0.0.1:1/unreachable_test',
  'postgresql://u:secret@localhost:5432/tasktracker_test',
  'postgres://u:secret@localhost:5432/tasktracker_test?sslmode=disable&application_name=a%20b',
  'postgres://u:secret%20word@localhost:5432/tasktracker_test',
  'postgres://u:secret@localhost:5432/tasks%5Ftest',
];

/**
 * Runs the guard on `url` and returns the message of the error it throws.
 *
 * @param url - The connection string under test.
 * @returns The thrown error's message.
 * @throws Error when the guard accepts `url`, or rethrows a non-`Error` value it threw.
 */
function guardMessage(url: string): string {
  try {
    assertTestDatabaseUrl(url);
  } catch (err) {
    if (err instanceof Error) {
      return err.message;
    }
    throw err;
  }
  throw new Error(`assertTestDatabaseUrl accepted ${url}`);
}

describe('assertTestDatabaseUrl', () => {
  // Every path below ends in `_test`, so only the scheme check can refuse these URLs.
  it.each([
    'socket:/some_pg_socket_test?db=tasktracker',
    'socket://u:secret@localhost/run_test?db=tasktracker',
    'http://u:secret@localhost:5432/tasktracker_test',
    'mysql://u:secret@localhost/tasktracker_test',
    'file:///tmp/tasktracker_test',
  ])('refuses %s because its scheme is not postgres: or postgresql:', (url) => {
    const message = guardMessage(url);

    expect(message).toBe(PROTOCOL_MESSAGE);
    expect(message).not.toContain(PASSWORD);
  });

  it.each(ACCEPTED_URLS)('returns %s unchanged', (url) => {
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  // The guard's verdict is checked against the driver's: a `_test` name read from the path is
  // only safe if `pg` resolves the same string to a `_test` database too.
  it.each(ACCEPTED_URLS)('accepts %s, which pg also resolves to a _test database', (url) => {
    expect(new pg.Client({ connectionString: url }).database).toMatch(/_test$/);
  });

  it('refuses a URL whose decoded path ends in _test but whose pg database does not', () => {
    expect(decodeURIComponent(new URL(REWRITTEN_TARGET_URL).pathname.slice(1))).toBe('tasks_test');
    expect(new pg.Client({ connectionString: REWRITTEN_TARGET_URL }).database).toBe('tasks%5Ftest');
    expect(guardMessage(REWRITTEN_TARGET_URL)).toBe(REWRITE_MESSAGE);
  });

  // Raw spaces in the path, the password and the query string, and at the very end; then `%5G`,
  // `%G1`, and a `%` or `%5` ending the part, in the path, the password and the query string.
  // `pg` re-encodes most of these before reading the database; the rest are no valid escape.
  it.each([
    'postgres://u:secret@localhost/tasks tracker_test',
    'postgres://u:secret word@localhost/tasktracker_test',
    'postgres://u:secret@localhost/tasktracker_test?application_name=a b',
    'postgres://u:secret@localhost/tasktracker_test ',
    'postgres://u:secret@localhost/tasks%5Gtracker_test',
    'postgres://u:secret@localhost/tasks%G1tracker_test',
    'postgres://u:secret@localhost/tasktracker_test%',
    'postgres://u:secret@localhost/tasktracker_test%5',
    'postgres://u:secret%5G@localhost/tasktracker_test',
    'postgres://u:secret%G1@localhost/tasktracker_test',
    'postgres://u:secret%@localhost/tasktracker_test',
    'postgres://u:secret%5@localhost/tasktracker_test',
    'postgres://u:secret@localhost/tasktracker_test?application_name=a%5Gb',
    'postgres://u:secret@localhost/tasktracker_test?application_name=a%G1b',
    'postgres://u:secret@localhost/tasktracker_test?application_name=a%',
    'postgres://u:secret@localhost/tasktracker_test?application_name=a%5',
  ])('refuses %j, which holds a raw space or a malformed percent-escape', (url) => {
    const message = guardMessage(url);

    expect(message).toBe(REWRITE_MESSAGE);
    expect(message).not.toContain(PASSWORD);
  });

  it('still refuses a postgres:// URL whose database name does not end in _test', () => {
    const message = guardMessage('postgres://u:secret@localhost:5432/tasktracker');

    expect(message).toBe('Refusing to use database "tasktracker": its name must end in _test');
    expect(message).not.toContain(PASSWORD);
  });
});

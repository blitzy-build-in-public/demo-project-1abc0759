/**
 * Unit tests for `assertTestDatabaseUrl`, the guard both global setups run before they migrate
 * the database `DATABASE_URL` names, and before the end-to-end setup truncates it.
 *
 * `pg` takes a `socket:` URL's database from its `db` query parameter rather than the path, so a
 * guard that read only the path would let `socket:/some_pg_socket_test?db=tasktracker` reach the
 * development database. The guard therefore refuses every scheme but `postgres:` and
 * `postgresql:` before it checks that the name ends in `_test`. The guard only parses its input,
 * so no case here opens a connection or needs a database.
 */

import { assertTestDatabaseUrl } from '../helpers/test-db';

/** The guard's message for any URL that is not `postgres://` or `postgresql://`. */
const PROTOCOL_MESSAGE = 'DATABASE_URL must be a postgres:// connection string';

/** Password carried by the credential-bearing cases; no guard message may echo it. */
const PASSWORD = 'secret';

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

  it.each([
    'postgres://tasktracker:x@127.0.0.1:1/unreachable_test',
    'postgresql://u:secret@localhost:5432/tasktracker_test',
  ])('returns %s unchanged', (url) => {
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  it('still refuses a postgres:// URL whose database name does not end in _test', () => {
    const message = guardMessage('postgres://u:secret@localhost:5432/tasktracker');

    expect(message).toBe('Refusing to use database "tasktracker": its name must end in _test');
    expect(message).not.toContain(PASSWORD);
  });
});

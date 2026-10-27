/**
 * Unit tests for `loadConfig` and `loadDatabaseUrl`: the defaults, the accepted values, every
 * `ConfigError` with its exact message, and the order in which the four variables are checked.
 *
 * Every case of the two functions passes a plain object as the environment and never touches the
 * process environment. `npm test` runs this project with `DATABASE_URL` set in the shell, so the
 * cases where it is missing also show that both functions read only their argument.
 *
 * The `DATABASE_URL` forms that need care (`postgresql://`, scheme case, whitespace, control
 * characters and percent-escapes) are covered here as well, each case for both functions.
 *
 * This file also covers `assertTestDatabaseUrl` from `tests/helpers/test-db.ts`, the guard both
 * global setups run before they migrate the database `DATABASE_URL` names, and before the
 * end-to-end setup truncates it. It refuses any scheme but `postgres:` and `postgresql:` with the
 * same message as the configuration loader. The guard only parses its input, and constructing a
 * `pg.Client` only parses its connection string, so no case here opens a connection or needs a
 * database.
 */

import pg from 'pg';

import { ConfigError, loadConfig, loadDatabaseUrl } from '../../src/config';
import type { AppConfig } from '../../src/config';

import { assertTestDatabaseUrl } from '../helpers/test-db';

const DATABASE_URL_MESSAGE = 'DATABASE_URL must be a postgres:// connection string';
const SESSION_SECRET_MESSAGE = 'SESSION_SECRET is required (at least 32 characters)';
const PORT_MESSAGE = 'PORT must be an integer between 1 and 65535';
const NODE_ENV_MESSAGE = 'NODE_ENV must be production, development or test';

/** A valid connection string whose password is a placeholder. */
const DB = 'postgres://tasktracker:pw@localhost:5432/tasktracker';

/**
 * A placeholder secret of exactly the 32-character minimum, so every case that loads
 * successfully also shows that the boundary length is accepted.
 */
const SECRET = 's'.repeat(32);

/** What `loadConfig` returns when only the two required variables are set. */
const DEFAULTS: AppConfig = {
  databaseUrl: DB,
  sessionSecret: SECRET,
  port: 3000,
  nodeEnv: 'development',
  isProduction: false,
};

/** An environment in which all four variables are invalid. */
const ALL_INVALID: NodeJS.ProcessEnv = {
  DATABASE_URL: 'mysql://x',
  SESSION_SECRET: 'short',
  PORT: '0',
  NODE_ENV: 'staging',
};

/** Returns an environment holding the valid required variables, overlaid with `extra`. */
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { DATABASE_URL: DB, SESSION_SECRET: SECRET, ...extra };
}

/** Returns `env()` with `name` removed when `value` is `undefined`, or set to `value` otherwise. */
function envWith(name: string, value: string | undefined): NodeJS.ProcessEnv {
  const result = env();
  if (value === undefined) {
    delete result[name];
  } else {
    result[name] = value;
  }
  return result;
}

/**
 * Asserts that `fn` throws a `ConfigError` whose message is exactly `message`.
 *
 * @throws Error when `fn` returns instead of throwing.
 */
function expectConfigError(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(ConfigError);
    expect(err instanceof ConfigError ? err.message : undefined).toBe(message);
    return;
  }
  throw new Error(`expected a ConfigError with message "${message}", but the call returned`);
}

describe('loadConfig defaults and accepted values', () => {
  test.each<[string, NodeJS.ProcessEnv]>([
    ['unset', {}],
    ['empty', { PORT: '', NODE_ENV: '' }],
  ])('defaults PORT to 3000 and NODE_ENV to development when they are %s', (_case, extra) => {
    expect(loadConfig(env(extra))).toEqual(DEFAULTS);
  });

  test.each<[AppConfig['nodeEnv'], boolean]>([
    ['production', true],
    ['development', false],
    ['test', false],
  ])('NODE_ENV=%s gives isProduction %s', (nodeEnv, isProduction) => {
    expect(loadConfig(env({ NODE_ENV: nodeEnv }))).toEqual({ ...DEFAULTS, nodeEnv, isProduction });
  });

  test.each<[string, number]>([
    ['1', 1],
    ['65535', 65535],
    ['3100', 3100],
  ])('PORT=%s gives the number %d', (raw, port) => {
    expect(loadConfig(env({ PORT: raw })).port).toBe(port);
  });
});

describe('loadConfig refusals', () => {
  // `undefined` stands for a variable that is absent from the environment.
  describe.each<[string, string, readonly (string | undefined)[]]>([
    ['DATABASE_URL', DATABASE_URL_MESSAGE, [undefined, '', 'mysql://u:p@localhost/x', 'not a url']],
    ['SESSION_SECRET', SESSION_SECRET_MESSAGE, [undefined, '', 's'.repeat(31)]],
    // Decimal digits only: `Number()` would read the last four as 1000, 80, 80 and 80.
    ['PORT', PORT_MESSAGE, ['0', '65536', 'abc', '3.5', '-1', '1e3', '0x50', '+80', ' 80']],
    // Exact values only, so a typo cannot silently drop the `Secure` cookie attribute.
    ['NODE_ENV', NODE_ENV_MESSAGE, ['staging', 'Production', 'production ']],
  ])('%s', (name, message, values) => {
    test.each(values)('refuses %p with the fixed message', (value) => {
      expectConfigError(() => loadConfig(envWith(name, value)), message);
    });
  });
});

describe('loadConfig check order', () => {
  test.each<[string, NodeJS.ProcessEnv, string]>([
    ['DATABASE_URL', ALL_INVALID, DATABASE_URL_MESSAGE],
    ['SESSION_SECRET', { ...ALL_INVALID, DATABASE_URL: DB }, SESSION_SECRET_MESSAGE],
    ['PORT', { ...ALL_INVALID, DATABASE_URL: DB, SESSION_SECRET: SECRET }, PORT_MESSAGE],
  ])('reports %s when it and every later variable are invalid', (_first, environment, message) => {
    expectConfigError(() => loadConfig(environment), message);
  });
});

describe('loadDatabaseUrl', () => {
  test.each<[string, NodeJS.ProcessEnv]>([
    ['only DATABASE_URL is set', { DATABASE_URL: DB }],
    ['every other variable is invalid', { ...ALL_INVALID, DATABASE_URL: DB }],
  ])('returns DATABASE_URL unchanged when %s', (_case, environment) => {
    expect(loadDatabaseUrl(environment)).toBe(DB);
  });

  test.each([undefined, '', 'mysql://x'])(
    'refuses DATABASE_URL %p with the fixed message',
    (value) => {
      expectConfigError(
        () => loadDatabaseUrl(envWith('DATABASE_URL', value)),
        DATABASE_URL_MESSAGE,
      );
    },
  );
});

// WHATWG URL parsing accepts `postgres:` values without `//` and silently drops surrounding
// whitespace and control characters, while `pg` parses the raw string itself. Such a value would
// reach a different host or database than the one validated, for example host `base` for a
// leading space, so both functions refuse it with the fixed configuration message instead.
// A raw space or a malformed percent-escape anywhere in the value is refused for the same reason:
// `pg` then re-encodes the whole string before reading it, so valid escapes such as `%5F` no
// longer decode, and a trailing `%` makes it throw. Well-formed escapes are accepted unchanged.
describe('DATABASE_URL forms', () => {
  // No `//` after the scheme; whitespace around or in the URL; control characters in it; then a
  // `%` that does not start a two-hex-digit escape.
  test.each([
    'postgres:foo',
    'postgres:',
    'postgresql:foo',
    'postgres:/h/d',
    ' postgres://u:p@h/d',
    'postgres://u:p@h/d ',
    '\tpostgres://u:p@h/d',
    'postgres://u:p@h/d\n',
    'postgres://u:p@h/d\u00a0',
    'postgres://u:p@h/\td',
    'postgres://u:p w@h/tasks%5Ftest',
    'postgres://u:p@h/d x',
    'postgres://u:p@h/d\u2028',
    'postgres://u:p@h/d\u0001',
    'postgres://u:p%zz@h/d',
    'postgres://u:pass%@h/d',
    'postgres://u:p@h/d%4',
  ])('refuses %j with the fixed message', (value) => {
    expectConfigError(
      () => loadConfig({ DATABASE_URL: value, SESSION_SECRET: SECRET }),
      DATABASE_URL_MESSAGE,
    );
    expectConfigError(() => loadDatabaseUrl({ DATABASE_URL: value }), DATABASE_URL_MESSAGE);
  });

  // The scheme is matched case-insensitively, as URL schemes are; well-formed percent-escapes and
  // a bracketed IPv6 host are kept as given.
  test.each([
    'postgres://u:p@h:5432/d',
    'postgresql://u:p@h/d',
    'POSTGRES://u:p@h/d',
    'PostgreSQL://u:p@h/d?sslmode=require',
    'postgres://alice%40example.com:p%2Fw%20x@h/d',
    'postgres://u:p@[::1]:5432/d',
  ])('accepts %j and returns it unchanged', (value) => {
    expect(loadConfig({ DATABASE_URL: value, SESSION_SECRET: SECRET }).databaseUrl).toBe(value);
    expect(loadDatabaseUrl({ DATABASE_URL: value })).toBe(value);
  });
});

/**
 * The guard's message for any URL that is not `postgres://` or `postgresql://`, the same as the
 * configuration loader's.
 */
const PROTOCOL_MESSAGE = DATABASE_URL_MESSAGE;

/** The guard's message for any URL holding a raw space or a malformed percent-escape. */
const REWRITE_MESSAGE =
  'DATABASE_URL must not contain a raw space or a malformed percent-escape; ' +
  'encode them as %20 and %25';

/** Password carried by the credential-bearing guard cases; no guard message may echo it. */
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

// `pg` takes a `socket:` URL's database from its `db` query parameter rather than the path, so a
// guard that read only the path would let `socket:/some_pg_socket_test?db=tasktracker` reach the
// development database. The guard therefore refuses every scheme but `postgres:` and
// `postgresql:` before it checks that the name ends in `_test`.
//
// `pg` also re-encodes a connection string holding a raw space or a malformed percent-escape
// before it reads the database, so `postgres://user:pass word@localhost/tasks%5Ftest`, whose path
// decodes to `tasks_test`, connects to `tasks%5Ftest`. The guard therefore refuses every such
// string, and each URL it accepts is also resolved by `pg`'s own parser to confirm that the
// database `pg` would use ends in `_test`.
describe('assertTestDatabaseUrl, the test-database guard of both global setups', () => {
  // Every path below ends in `_test`, so only the scheme check can refuse these URLs.
  test.each([
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

  test.each(ACCEPTED_URLS)('returns %s unchanged', (url) => {
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  // The guard's verdict is checked against the driver's: a `_test` name read from the path is
  // only safe if `pg` resolves the same string to a `_test` database too.
  test.each(ACCEPTED_URLS)('accepts %s, which pg also resolves to a _test database', (url) => {
    expect(new pg.Client({ connectionString: url }).database).toMatch(/_test$/);
  });

  test('refuses a URL whose decoded path ends in _test but whose pg database does not', () => {
    expect(decodeURIComponent(new URL(REWRITTEN_TARGET_URL).pathname.slice(1))).toBe('tasks_test');
    expect(new pg.Client({ connectionString: REWRITTEN_TARGET_URL }).database).toBe('tasks%5Ftest');
    expect(guardMessage(REWRITTEN_TARGET_URL)).toBe(REWRITE_MESSAGE);
  });

  // Raw spaces in the path, the password and the query string, and at the very end; then `%5G`,
  // `%G1`, and a `%` or `%5` ending the part, in the path, the password and the query string.
  // `pg` re-encodes most of these before reading the database; the rest are no valid escape.
  test.each([
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

  test('still refuses a postgres:// URL whose database name does not end in _test', () => {
    const message = guardMessage('postgres://u:secret@localhost:5432/tasktracker');

    expect(message).toBe('Refusing to use database "tasktracker": its name must end in _test');
    expect(message).not.toContain(PASSWORD);
  });
});

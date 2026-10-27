/**
 * Unit tests for the `DATABASE_URL` rule that `loadConfig` and `loadDatabaseUrl` share.
 *
 * WHATWG URL parsing accepts `postgres:` values without `//` and silently drops surrounding
 * whitespace and control characters, while `pg` parses the raw string itself. Such a value would
 * reach a different host or database than the one validated, for example host `base` for a
 * leading space, so both functions refuse it with the fixed configuration message instead.
 * A raw space or a malformed percent-escape anywhere in the value is refused for the same reason:
 * `pg` then re-encodes the whole string before reading it, so valid escapes such as `%5F` no
 * longer decode, and a trailing `%` makes it throw. Well-formed escapes are accepted unchanged.
 *
 * Every case passes a plain object as the environment, so none reads the process environment or
 * opens a connection.
 */

import { randomBytes } from 'node:crypto';

import { ConfigError, loadConfig, loadDatabaseUrl } from '../../src/config';

/** The fixed message for any `DATABASE_URL` that is missing or not a postgres:// URL. */
const DATABASE_URL_MESSAGE = 'DATABASE_URL must be a postgres:// connection string';

/**
 * A session secret generated at run time, 64 hex characters and so valid, so only `DATABASE_URL`
 * can make `loadConfig` throw.
 */
const SESSION_SECRET = randomBytes(32).toString('hex');

/**
 * Runs `load` and returns the message of the `ConfigError` it throws.
 *
 * @param load - The configuration call under test.
 * @returns The thrown `ConfigError`'s message.
 * @throws Error when `load` returns, or rethrows anything it threw that is not a `ConfigError`.
 */
function configErrorMessage(load: () => unknown): string {
  try {
    load();
  } catch (err) {
    if (err instanceof ConfigError) {
      return err.message;
    }
    throw err;
  }
  throw new Error('expected a ConfigError, but the call returned');
}

describe('DATABASE_URL validation', () => {
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
    expect(configErrorMessage(() => loadConfig({ DATABASE_URL: value, SESSION_SECRET }))).toBe(
      DATABASE_URL_MESSAGE,
    );
    expect(configErrorMessage(() => loadDatabaseUrl({ DATABASE_URL: value }))).toBe(
      DATABASE_URL_MESSAGE,
    );
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
    expect(loadConfig({ DATABASE_URL: value, SESSION_SECRET }).databaseUrl).toBe(value);
    expect(loadDatabaseUrl({ DATABASE_URL: value })).toBe(value);
  });
});

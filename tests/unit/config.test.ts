/**
 * Unit tests for `loadConfig` and `loadDatabaseUrl`: the defaults, the accepted values, every
 * `ConfigError` with its exact message, and the order in which the four variables are checked.
 *
 * Every case passes a plain object as the environment and never touches the process environment.
 * `npm test` runs this project with `DATABASE_URL` set in the shell, so the cases where it is
 * missing also show that both functions read only their argument.
 *
 * The `DATABASE_URL` forms that need care (`postgresql://`, scheme case, whitespace, control
 * characters and percent-escapes) are covered, for both functions, in
 * `config-database-url.test.ts` and are not repeated here.
 */

import { ConfigError, loadConfig, loadDatabaseUrl } from '../../src/config';
import type { AppConfig } from '../../src/config';

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

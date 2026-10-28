/**
 * Environment configuration: the only module that parses and validates environment variables.
 *
 * The process entry points pass their environment in, so this module never reads the global one
 * and every rule can be exercised with a plain object. They also pass it to
 * {@link removePgVariables}, so the database driver cannot take connection settings from
 * anything but `DATABASE_URL`. Error messages are fixed strings and never include the received
 * value, because `DATABASE_URL` carries a password and `SESSION_SECRET` is a secret.
 * {@link databaseCredentials} lists the credentials of an accepted `DATABASE_URL`, which
 * the entry points hand to their loggers to redact from driver error text.
 */

/** Validated application configuration, built once at start-up by {@link loadConfig}. */
export interface AppConfig {
  /** PostgreSQL connection string for the pool and the migration runner. */
  databaseUrl: string;
  /** Key for the `sid` cookie signature and the CSRF HMAC; at least 32 characters. */
  sessionSecret: string;
  /** HTTP listen port, from 1 to 65535. */
  port: number;
  /** Runtime mode. */
  nodeEnv: 'production' | 'development' | 'test';
  /** `true` only when `nodeEnv` is `production`; adds `Secure` to the `sid` and `csrf` cookies. */
  isProduction: boolean;
}

/**
 * Raised when an environment variable is missing or invalid. The message is one of the fixed
 * strings documented on {@link loadConfig}; the entry point logs it and exits with code 1.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DATABASE_URL_MESSAGE = 'DATABASE_URL must be a postgres:// connection string';
const SESSION_SECRET_MESSAGE = 'SESSION_SECRET is required (at least 32 characters)';
const PORT_MESSAGE = 'PORT must be an integer between 1 and 65535';
const NODE_ENV_MESSAGE = 'NODE_ENV must be production, development or test';

// The 32-character floor is this application's own addition, giving the HMAC key adequate strength.
const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_NODE_ENV: AppConfig['nodeEnv'] = 'development';

/**
 * Returns the value the driver's connection-string parser takes for the query parameter `name`:
 * the last one given, or `''` when there is none.
 */
function lastQueryValue(url: URL, name: string): string {
  return url.searchParams.getAll(name).at(-1) ?? '';
}

function parseDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  // URL parsing alone is too lenient: it accepts `postgres:` forms without `//` and silently
  // strips surrounding whitespace and control characters, which the pg driver reads differently,
  // so the value validated would not name the server and database the driver connects to.
  // A raw space or a malformed percent-escape likewise makes pg re-encode the whole string
  // before reading it, which alters valid escapes and IPv6 brackets, or throws on a trailing `%`.
  if (
    !/^postgres(?:ql)?:\/\//i.test(raw) ||
    /\s/.test(raw) ||
    /%(?![0-9a-f]{2})/i.test(raw) ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The parser's error carries the input, which includes the password, so it is discarded
    // rather than attached as `cause`.
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  // The driver fills a host, user name or database the URL lacks from its `PG*` variables, the
  // `USER` variable or its own defaults, so such a URL would connect to a server, as a role or
  // to a database this value does not name. It reads the host and the user name from the last
  // `host` and `user` query parameters when they are non-empty, else from the URL itself, and
  // the database from the path alone.
  const host = lastQueryValue(url, 'host') || url.hostname;
  const user = lastQueryValue(url, 'user') || url.username;
  if (host === '' || user === '' || url.pathname.slice(1) === '') {
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  return raw;
}

function parseSessionSecret(raw: string | undefined): string {
  if (raw === undefined || raw.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(SESSION_SECRET_MESSAGE);
  }
  return raw;
}

function parsePort(raw: string | undefined): number {
  // `node --env-file` yields '' for a bare `PORT=` line, so an empty value counts as unset.
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigError(PORT_MESSAGE);
  }
  const port = Number(raw);
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new ConfigError(PORT_MESSAGE);
  }
  return port;
}

function parseNodeEnv(raw: string | undefined): AppConfig['nodeEnv'] {
  if (raw === undefined) {
    return DEFAULT_NODE_ENV;
  }
  if (raw === 'production' || raw === 'development' || raw === 'test') {
    return raw;
  }
  // Unknown values such as `staging` are refused rather than treated as non-production, so a
  // deployment typo cannot silently drop the `Secure` cookie attribute. An empty value is
  // refused too: `docker run -e NODE_ENV=` or a bare `NODE_ENV=` line read by `node --env-file`
  // overrides the image's `production`, so treating it as unset would drop `Secure` silently.
  throw new ConfigError(NODE_ENV_MESSAGE);
}

/**
 * Parses and validates the application's environment variables.
 *
 * Variables are checked in this order, and the first failure throws a {@link ConfigError}:
 * - `DATABASE_URL`: required; a URL beginning with `postgres://` or `postgresql://` (scheme
 *   case-insensitive), with no whitespace, no control characters, and every `%` starting a
 *   two-hex-digit escape (encode a space as `%20` and a literal `%` as `%25`). It must name a
 *   host and a user name, each in the URL or in a non-empty `host` or `user` query parameter,
 *   and a database in its path, so that no driver variable or default fills them in. It is
 *   returned unchanged. Otherwise: `DATABASE_URL must be a postgres:// connection string`.
 * - `SESSION_SECRET`: required; at least 32 characters, not trimmed.
 *   Otherwise: `SESSION_SECRET is required (at least 32 characters)`.
 * - `PORT`: optional, default `3000` when unset or empty; decimal digits only, 1 to 65535.
 *   Otherwise: `PORT must be an integer between 1 and 65535`.
 * - `NODE_ENV`: optional, default `development` only when unset; exactly `production`,
 *   `development` or `test`, so an empty value is refused as well.
 *   Otherwise: `NODE_ENV must be production, development or test`.
 *
 * @param env - The process environment, passed in by the entry point; never read globally.
 * @returns The validated configuration, with `isProduction` true only for `production`.
 * @throws {ConfigError} With one of the fixed messages above; never includes a received value.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const databaseUrl = parseDatabaseUrl(env.DATABASE_URL);
  const sessionSecret = parseSessionSecret(env.SESSION_SECRET);
  const port = parsePort(env.PORT);
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  return {
    databaseUrl,
    sessionSecret,
    port,
    nodeEnv,
    isProduction: nodeEnv === 'production',
  };
}

/**
 * Reads only `DATABASE_URL`, for the migration CLI, which needs no session secret.
 *
 * @param env - The process environment, passed in by the entry point; never read globally.
 * @returns The `postgres://` or `postgresql://` connection string, unchanged.
 * @throws {ConfigError} `DATABASE_URL must be a postgres:// connection string` when the value is
 *   missing, blank, not a URL, does not begin with `postgres://` or `postgresql://` (scheme
 *   case-insensitive), contains whitespace or a control character, has a `%` that does not
 *   start a two-hex-digit escape (encode a space as `%20` and a literal `%` as `%25`), or lacks
 *   a host, a user name (each given in the URL or a non-empty `host` or `user` query parameter)
 *   or a database name in its path.
 */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return parseDatabaseUrl(env.DATABASE_URL);
}

/**
 * Deletes every variable whose name begins with `PG` from `env`, in place.
 *
 * The PostgreSQL driver reads such variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
 * `PGSSLMODE`, `PGAPPNAME`, `PGPASSFILE` and others) each time it creates a client, and takes
 * from them any connection setting the connection string leaves open, the TLS mode included.
 * The application reads only its four variables, so each entry point calls this once its
 * configuration is accepted and before it creates a pool, which leaves `DATABASE_URL` the only
 * source of the connection.
 *
 * @param env - The process environment, passed in by the entry point; never read globally.
 */
export function removePgVariables(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith('PG')) {
      delete env[name];
    }
  }
}

/**
 * The credentials of a connection string, as {@link databaseCredentials} lists them. Each list
 * holds distinct non-empty values, longest first, and is empty when the URL carries none.
 */
export interface DatabaseCredentials {
  /** The user name of the user-info part, as written and decoded, and every `user` parameter. */
  userNames: string[];
  /** The password of the user-info part, as written and decoded, and every `password` parameter. */
  passwords: string[];
}

/** Returns `value` percent-decoded, or unchanged when it holds a malformed escape. */
function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function distinctLongestFirst(values: readonly string[]): string[] {
  const distinct = new Set(values.filter((value) => value !== ''));
  return [...distinct].sort((a, b) => b.length - a.length);
}

/**
 * Lists the credentials a connection string carries, for the entry points' loggers to redact:
 * the user name and password of its user-info part, and every `user` and `password` query
 * parameter, which the driver's connection-string parser reads in preference to that part.
 *
 * The driver sends the percent-decoded user name, and that is the form PostgreSQL quotes in its
 * messages, so `alice%40example.com` is reported as `alice@example.com`. The user-info values are
 * therefore listed both as written and decoded; the query API already returns decoded values.
 * User names and passwords are listed apart because the logger redacts each only where it
 * stands as the credential, and the contexts differ: a user name in a URL, a quoted role or a
 * `user=` setting, a password in a URL or a password setting.
 *
 * @param databaseUrl - A connection string accepted by {@link loadConfig} or
 *   {@link loadDatabaseUrl}.
 * @returns The user names and the passwords, each distinct, non-empty and longest first.
 * @throws {ConfigError} `DATABASE_URL must be a postgres:// connection string` when
 *   `databaseUrl` does not parse as a URL; the parser's own error, which quotes the input, is
 *   discarded.
 */
export function databaseCredentials(databaseUrl: string): DatabaseCredentials {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  return {
    userNames: distinctLongestFirst([
      url.username,
      percentDecode(url.username),
      ...url.searchParams.getAll('user'),
    ]),
    passwords: distinctLongestFirst([
      url.password,
      percentDecode(url.password),
      ...url.searchParams.getAll('password'),
    ]),
  };
}

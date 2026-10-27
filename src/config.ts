/**
 * Environment configuration: the only module that parses and validates environment variables.
 *
 * The process entry points pass their environment in, so this module never reads the global one
 * and every rule can be exercised with a plain object. Error messages are fixed strings and never
 * include the received value, because `DATABASE_URL` carries a password and `SESSION_SECRET` is a
 * secret.
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
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    // The parser's error carries the input, which includes the password, so it is discarded
    // rather than attached as `cause`.
    throw new ConfigError(DATABASE_URL_MESSAGE);
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
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
  if (raw === undefined || raw === '') {
    return DEFAULT_NODE_ENV;
  }
  if (raw === 'production' || raw === 'development' || raw === 'test') {
    return raw;
  }
  // Unknown values such as `staging` are refused rather than treated as non-production, so a
  // deployment typo cannot silently drop the `Secure` cookie attribute.
  throw new ConfigError(NODE_ENV_MESSAGE);
}

/**
 * Parses and validates the application's environment variables.
 *
 * Variables are checked in this order, and the first failure throws a {@link ConfigError}:
 * - `DATABASE_URL`: required; a URL beginning with `postgres://` or `postgresql://` (scheme
 *   case-insensitive), with no whitespace, no control characters, and every `%` starting a
 *   two-hex-digit escape (encode a space as `%20` and a literal `%` as `%25`), returned
 *   unchanged. Otherwise: `DATABASE_URL must be a postgres:// connection string`.
 * - `SESSION_SECRET`: required; at least 32 characters, not trimmed.
 *   Otherwise: `SESSION_SECRET is required (at least 32 characters)`.
 * - `PORT`: optional, default `3000` when unset or empty; decimal digits only, 1 to 65535.
 *   Otherwise: `PORT must be an integer between 1 and 65535`.
 * - `NODE_ENV`: optional, default `development` when unset or empty; exactly `production`,
 *   `development` or `test`. Otherwise: `NODE_ENV must be production, development or test`.
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
 *   case-insensitive), contains whitespace or a control character, or has a `%` that does not
 *   start a two-hex-digit escape (encode a space as `%20` and a literal `%` as `%25`).
 */
export function loadDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return parseDatabaseUrl(env.DATABASE_URL);
}

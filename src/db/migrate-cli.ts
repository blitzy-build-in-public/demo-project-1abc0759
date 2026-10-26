/**
 * `npm run migrate` entry point: applies pending migrations without starting the server.
 *
 * This file is composition-root code that lives in `src/db`. It is one of the two process entry
 * points, with `src/server.ts`, and those two are the only files that read `process.env`; it
 * passes the environment straight to `src/config.ts`. Its import of `../config` is therefore the
 * intended exception to the data-access layer's import rule, and the layer-map test classes this
 * file with the entry points. No other module in `src/db` may import `../config`.
 *
 * Exit status: 0 when every pending migration was applied (or none was pending), 1 when
 * `DATABASE_URL` is invalid or a migration fails. The connection string is never logged, because
 * it carries the database password.
 *
 * Every line written once `DATABASE_URL` is accepted, the runner's and the pool's included, has
 * the database user name and password of that URL replaced by `[redacted]` in the error's
 * message and stack, the only parts of a line that carry driver text. The user name can be an
 * email address, and PostgreSQL quotes it in its own messages, for example
 * `password authentication failed for user "…"` (SQLSTATE 28P01). The envelope (`time`, `level`,
 * `msg`), the fields and the error's name and code are kept as written.
 */

import { Writable } from 'node:stream';

import { ConfigError, loadDatabaseUrl } from '../config';
import { createLogger } from '../shared/logger';
import type { Logger } from '../shared/logger';
import { runMigrations } from './migrate';
import { createPool } from './pool';

/** Text that stands in for each occurrence of a connection credential in a log line. */
const REDACTED = '[redacted]';

/**
 * Query parameters that the driver's connection-string parser reads as the user name and the
 * password, taking precedence over the URL's user-info part.
 */
const CREDENTIAL_PARAMS: readonly string[] = ['user', 'password'];

/** Returns `value` percent-decoded, or unchanged when it holds a malformed escape. */
function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Lists the credentials `databaseUrl` carries: the user name and password of its user-info part,
 * and every `user` and `password` query parameter.
 *
 * The driver sends the percent-decoded user name, and that is the form PostgreSQL quotes in its
 * messages, so `alice%40example.com` is reported as `alice@example.com`. The user-info values are
 * therefore listed both as written and decoded; the query API already returns decoded values.
 *
 * @param databaseUrl Connection string accepted by `loadDatabaseUrl`, so it parses as a URL.
 * @returns The distinct non-empty values, longest first.
 */
function connectionCredentials(databaseUrl: string): string[] {
  const url = new URL(databaseUrl);
  const values = [
    url.username,
    percentDecode(url.username),
    url.password,
    percentDecode(url.password),
  ];
  for (const name of CREDENTIAL_PARAMS) {
    values.push(...url.searchParams.getAll(name));
  }
  const distinct = new Set(values.filter((value) => value !== ''));
  return [...distinct].sort((a, b) => b.length - a.length);
}

/**
 * Builds one pattern matching any of `credentials`. The alternatives keep their longest-first
 * order, so a credential that contains another is replaced whole rather than in part, and a single
 * pass never matches inside a {@link REDACTED} marker it has just written.
 */
function credentialPattern(credentials: readonly string[]): RegExp {
  const alternatives = credentials.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(alternatives.join('|'), 'g');
}

/** The values of a line's `err` that can carry driver text. */
const ERROR_TEXT_KEYS: readonly string[] = ['message', 'stack'];

/** Returns true when `value` is a parsed JSON object, which excludes `null` and arrays. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replaces every credential match in the `message` and `stack` of a parsed entry's `err`, in
 * place. Nothing else in the entry is read or changed.
 */
function redactErrorText(entry: Record<string, unknown>, pattern: RegExp): void {
  // Only these two values can hold driver text: the logger reduces a thrown value to its name,
  // message, code and stack (a non-Error to its message alone), while `time`, `level`, `msg`,
  // the caller's fields, `err.name` and `err.code` are fixed values that code produces.
  // Redacting those as well would rewrite them whenever a credential equals one of them, such
  // as a user named `error` or a password of `28P01`.
  const err = entry.err;
  if (!isJsonObject(err)) {
    return;
  }
  for (const key of ERROR_TEXT_KEYS) {
    const text = err[key];
    if (typeof text === 'string') {
      err[key] = text.replace(pattern, REDACTED);
    }
  }
}

/**
 * Redacts one log line: the user name and password are replaced in the error's message and
 * stack, the only parts of a line that carry driver text, while the envelope (`time`, `level`,
 * `msg`), the fields and the error's name and code are kept. The logger writes JSON, whose
 * string escapes could hide a credential from a search of the raw text, so the line is parsed
 * and those two decoded values are redacted.
 */
function redactLine(line: string, pattern: RegExp): string {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // Not JSON, so there is no structure to keep: the raw text itself is redacted.
    return line.replace(pattern, REDACTED);
  }
  if (!isJsonObject(entry)) {
    // JSON but not an entry the logger writes, so it has no envelope to keep either.
    return line.replace(pattern, REDACTED);
  }
  redactErrorText(entry, pattern);
  return JSON.stringify(entry);
}

/**
 * Creates a stream that forwards each line to standard output with the user name and password
 * in `credentials` replaced by {@link REDACTED} in the error's message and stack, the only parts
 * of a line that carry driver text. The envelope, the fields and the error code are kept.
 *
 * The write callback completes synchronously, so Node hands over the next write at once instead
 * of buffering it, and every line reaches standard output before the logger call returns.
 */
function createRedactingStream(credentials: readonly string[]): Writable {
  const pattern = credentialPattern(credentials);
  return new Writable({
    decodeStrings: false,
    write(
      chunk: unknown,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = text
        .split('\n')
        .map((line) => (line === '' ? line : redactLine(line, pattern)));
      process.stdout.write(lines.join('\n'));
      callback();
    },
  });
}

/**
 * Creates the CLI's logger, which writes to standard output with the credentials of
 * `databaseUrl` redacted. Without a URL, or with one that carries no credentials, lines are
 * written unchanged.
 */
function createCliLogger(databaseUrl: string | undefined): Logger {
  const credentials = databaseUrl === undefined ? [] : connectionCredentials(databaseUrl);
  return createLogger(
    credentials.length === 0 ? process.stdout : createRedactingStream(credentials),
  );
}

/**
 * Applies every pending migration to the database named by `DATABASE_URL`, then closes the pool.
 *
 * - An invalid `DATABASE_URL` logs the fixed configuration message alone, with no error object,
 *   and sets exit code 1 without opening a connection. `SESSION_SECRET` is not required.
 * - `runMigrations` logs `migrations applied` with `count` and `versions` on success, which sets
 *   exit code 0.
 * - A migration failure, including an unreachable database, logs `migration failed` with the
 *   error and sets exit code 1.
 * - The pool is always ended, so the process exits instead of waiting on idle connections. A
 *   failure to end it is logged as `pool end failed` and can only set exit code 1, never replace
 *   the migration outcome that was already logged.
 * - Every line after the configuration is read, `migrations applied`, `migration failed`,
 *   `migration unlock failed`, `idle client error` and `pool end failed`, has the database user
 *   name (which can be an email address) and password of `DATABASE_URL` replaced by
 *   `[redacted]` in the error's message and stack, the only parts of a line that carry driver
 *   text. The envelope, the fields and the error code are kept.
 *
 * The result is reported through `process.exitCode` rather than `process.exit()`, so the log
 * lines written to stdout are flushed before the process ends.
 *
 * @returns A promise that resolves once the run has finished and the pool is ended. Every
 *   expected failure is logged and resolved; only an error that is not a {@link ConfigError}
 *   while reading the configuration rejects.
 */
export async function main(): Promise<void> {
  let databaseUrl: string;
  try {
    databaseUrl = loadDatabaseUrl(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      createLogger().error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // The pool and the runner log through this logger too, so their driver errors are redacted.
  const logger = createCliLogger(databaseUrl);
  const pool = createPool(databaseUrl, logger);
  try {
    await runMigrations(pool, logger);
    process.exitCode = 0;
  } catch (err) {
    logger.error('migration failed', err);
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (err) {
      logger.error('pool end failed', err);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  // `main` logs and resolves every failure it expects. The first handler reports anything that
  // escaped it; the second covers a failure of that log write itself, so the chain never rejects.
  void main()
    .catch((err: unknown): void => {
      process.exitCode = 1;
      let databaseUrl: string | undefined;
      try {
        databaseUrl = loadDatabaseUrl(process.env);
      } catch {
        // A refused DATABASE_URL never reached the driver, so there is nothing to redact.
        databaseUrl = undefined;
      }
      createCliLogger(databaseUrl).error('migration failed', err);
    })
    .catch((): void => {
      process.exitCode = 1;
    });
}

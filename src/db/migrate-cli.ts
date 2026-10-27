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
 * `DATABASE_URL` is invalid or a migration fails, and 2 when the command line holds anything but
 * `-h`/`--help`. `--help` prints the usage and exits 0; like a rejected command line, it neither
 * reads `DATABASE_URL` nor connects. The connection string is never logged, because it carries
 * the database password, and neither is a rejected argument, which can hold one.
 *
 * Every line written once `DATABASE_URL` is accepted, the runner's and the pool's included, has
 * the database user name and password of that URL replaced by `[redacted]` in the error's
 * message and stack, the only parts of a line that carry driver text. The user name can be an
 * email address, and PostgreSQL quotes it in its own messages, for example
 * `password authentication failed for user "…"` (SQLSTATE 28P01). The envelope (`time`, `level`,
 * `msg`), the fields and the error's name and code are kept as written. The redaction is the
 * shared logger's own, the boundary `src/server.ts` uses as well: `databaseCredentials` in
 * `src/config.ts` lists the values, and `createLogger` replaces them before a line is serialized.
 */

import { parseArgs } from 'node:util';

import { ConfigError, databaseCredentials, loadDatabaseUrl } from '../config';
import { createLogger } from '../shared/logger';
import type { Logger } from '../shared/logger';
import { runMigrations } from './migrate';
import { createPool } from './pool';

/** Usage text that `-h`/`--help` writes to standard output. */
const USAGE = [
  'Usage: node dist/db/migrate-cli.js [--help]',
  '       (also run as `npm run migrate`, or `npm run migrate:local` to read .env)',
  '',
  'Applies every pending migration to the database named by DATABASE_URL, then exits.',
  '',
  'Environment:',
  '  DATABASE_URL  Required. A postgres:// or postgresql:// connection string.',
  '',
  'Options:',
  '  -h, --help    Print this usage and exit, without reading DATABASE_URL or connecting.',
  '',
  'Exit status:',
  '  0  every pending migration was applied, or none was pending',
  '  1  DATABASE_URL is invalid, or a migration failed',
  '  2  invalid arguments',
  '',
].join('\n');

/** The one line logged for a rejected command line. */
const INVALID_ARGUMENTS = 'invalid arguments; run with --help for usage';

/** What the command line asks for: a migration run, the usage text, or neither. */
type CliRequest = 'migrate' | 'help' | 'invalid';

/**
 * Reads the command line. `-h`/`--help` is the only option; an unknown option, a value given to
 * `--help` or any positional argument makes the request invalid.
 */
function parseCliArgs(args: readonly string[]): CliRequest {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    });
    return values.help === true ? 'help' : 'migrate';
  } catch {
    // The parser's error is dropped on purpose: its message quotes the offending argument.
    return 'invalid';
  }
}

/**
 * Creates the CLI's logger on standard output. With a URL, the logger redacts that URL's database
 * user name and password from every logged error's message and stack (see
 * `databaseCredentials`); without one, or with one that carries no credentials, lines are written
 * unchanged.
 */
function createCliLogger(databaseUrl: string | undefined): Logger {
  return createLogger(process.stdout, {
    redact: databaseUrl === undefined ? [] : databaseCredentials(databaseUrl),
  });
}

/**
 * Applies every pending migration to the database named by `DATABASE_URL`, then closes the pool.
 *
 * - The command line is read first. `-h`/`--help` writes the usage text to standard output and
 *   sets exit code 0. Anything else on it, an unknown option, a value given to `--help` or a
 *   positional argument, logs `invalid arguments; run with --help for usage` alone, without the
 *   argument text, and sets exit code 2. Neither reads `DATABASE_URL` nor opens a connection.
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
 * @param args The command-line arguments after the script path, `process.argv.slice(2)` for the
 *   process entry. Defaults to none, which runs the migrations.
 * @returns A promise that resolves once the run has finished and the pool is ended. Every
 *   expected failure is logged and resolved; only an error that is not a {@link ConfigError}
 *   while reading the configuration rejects.
 */
export async function main(args: readonly string[] = []): Promise<void> {
  const request = parseCliArgs(args);
  if (request === 'help') {
    // Usage is help text, not a log event, so it bypasses the JSON logger.
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  if (request === 'invalid') {
    // The argument is not echoed: a mistyped command line can hold a connection string and its
    // password, which never reaches a log. Exit code 2 is the conventional command-line usage
    // error, kept apart from 1, an invalid DATABASE_URL or a failed migration.
    createLogger().error(INVALID_ARGUMENTS);
    process.exitCode = 2;
    return;
  }

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
  void main(process.argv.slice(2))
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

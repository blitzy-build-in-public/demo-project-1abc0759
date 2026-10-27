/**
 * Integration tests for the migrated schema against real PostgreSQL 16 (plan 0.5.2, 0.9.2), and
 * for the code that applies that schema and reports its failures.
 *
 * They check that the four versioned migrations apply exactly once, that the database itself
 * enforces every planned index, CHECK constraint and the case-insensitive email uniqueness, and
 * that deleting a user removes that user's sessions, tasks and login attempts. The last go
 * through the `users_delete_login_attempts` trigger, because `login_attempts` holds an email
 * rather than a user id and no foreign key can cascade to it.
 *
 * Check fixtures are raw INSERTs with every column and timestamp bound explicitly, never the
 * database's `now()`: the helper defaults deliberately satisfy every check.
 *
 * The suites before `database schema` cover that code without changing any table of the test
 * database, so they need no truncation:
 * - the migration runner, against a fake pool: the client goes back with a plain `release()`
 *   after a clean run and is destroyed once when the advisory unlock fails, whatever the logger
 *   does, and a connection the server ends mid-migration rejects with the emitted error as its
 *   cause instead of crashing the process;
 * - the migration CLI's `main`: the `DATABASE_URL` user name and password redacted from every
 *   logged error, exit codes 0, 1 and 2, and `--help` and rejected arguments that neither read
 *   `DATABASE_URL` nor connect. Its runner is a spy scoped to those tests, never a module mock,
 *   so every other suite here runs the real runner;
 * - the same `main` against the test database with the driver's `PG*` variables set: none of
 *   them, and no password file, changes the connection `DATABASE_URL` names or supplies the
 *   password it leaves out, and a URL lacking a host, user name or database is refused although
 *   those variables would complete it;
 * - the pool's connection teardown, against a fake PostgreSQL server: a connection pg rejects
 *   closes its socket at once, a connected client keeps its socket, and a statement the server
 *   leaves unanswered rejects as database-unavailable within one query timeout and destroys its
 *   connection, on the pool, on a checked-out client and in a transaction;
 * - the logger's serialisation of errors and fields, its guards against hostile inputs (throwing
 *   getters, proxies, cyclic and BigInt values) and its redaction of the values it is given.
 *
 * They live here because this is the suite of the migration bootstrap, and the runner, its CLI,
 * the pool and the logger are what that bootstrap runs on. Each restores what it changes: the
 * environment, standard output, the timers, its spies and `process.exitCode`.
 *
 * The final describe drops the `public` schema and rebuilds it from two pools at once, the way
 * replicas start together. It must stay last in this file, and it leaves the schema fully
 * migrated for the suites that follow in the same run.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import type { Pool, PoolClient } from 'pg';

import { runMigrations } from '../../src/db/migrate';
import * as migrateModule from '../../src/db/migrate';
import { main as runMigrateCli } from '../../src/db/migrate-cli';
import { createPool } from '../../src/db/pool';
import * as poolModule from '../../src/db/pool';
import { checkOut, query, withTransaction } from '../../src/db/query';
import { DatabaseUnavailableError } from '../../src/shared/errors';
import { createLogger } from '../../src/shared/logger';
import type {
  LogFields,
  Logger,
  LoggerOptions,
  RedactedCredentials,
} from '../../src/shared/logger';

import { CaptureLogger } from '../helpers/capture-logger';
import {
  countRows,
  createTestPool,
  insertLoginFailures,
  insertTask,
  insertUser,
  loginAttemptRows,
  sessionsForUser,
  sql,
  tasksForOwner,
  testDatabaseUrl,
  truncateAll,
} from '../helpers/test-db';

describe('runMigrations client release', () => {
  const LOCK_SQL = 'SELECT pg_advisory_lock(7253, 1)';
  const UNLOCK_SQL = 'SELECT pg_advisory_unlock(7253, 1)';
  const MIGRATION_VERSION = '0001_x';
  const MIGRATION_SQL = 'CREATE TABLE widgets (id integer);';
  const NOT_QUERYABLE_MESSAGE = 'Client has encountered a connection error and is not queryable';

  /** Which statements the fake client rejects. */
  interface FailurePlan {
    migration: boolean;
    unlock: boolean;
    /**
     * When set, the connection is lost while the migration file's SQL runs: the client emits this
     * error from outside any statement, as pg does from its socket, and then refuses that statement
     * and every later one with pg's "not queryable" error.
     */
    connectionLost?: Error;
  }

  /** A fake pool whose one client records its statements and every `release` call. */
  interface FakeDatabase {
    pool: Pool;
    client: EventEmitter;
    statements: string[];
    releaseCalls: unknown[][];
  }

  /**
   * Builds a pool whose `connect()` resolves one fake client. The client answers every statement
   * with no rows, except that it rejects the migration file's SQL with `migrationFailure` and the
   * unlock with `unlockFailure` when `fail` says so, and behaves as a dead client once
   * `fail.connectionLost` has been emitted.
   */
  function createFakeDatabase(
    fail: FailurePlan,
    migrationFailure: Error,
    unlockFailure: Error,
  ): FakeDatabase {
    const statements: string[] = [];
    const releaseCalls: unknown[][] = [];
    const events = new EventEmitter();
    let lost = false;
    const client = Object.assign(events, {
      async query(statement: string): Promise<{ rows: unknown[] }> {
        statements.push(statement);
        const connectionError = fail.connectionLost;
        if (connectionError !== undefined && statement === MIGRATION_SQL) {
          lost = true;
          // Emitted from a later macrotask, where nothing catches it: with no `error` listener on
          // the client, it is an uncaught exception, as it would crash the process.
          await new Promise<void>((resolve) => {
            setImmediate(() => {
              resolve();
              events.emit('error', connectionError);
            });
          });
        }
        if (lost) {
          throw new Error(NOT_QUERYABLE_MESSAGE);
        }
        if (fail.migration && statement === MIGRATION_SQL) {
          throw migrationFailure;
        }
        if (fail.unlock && statement === UNLOCK_SQL) {
          throw unlockFailure;
        }
        return { rows: [] };
      },
      release(...args: unknown[]): void {
        releaseCalls.push(args);
      },
    });
    const pool = {
      async connect(): Promise<PoolClient> {
        // Only `query`, `release` and the `error` event are used by the runner and `checkOut`, so
        // the fake stands in for the client.
        return client as unknown as PoolClient;
      },
    };
    return { pool: pool as unknown as Pool, client, statements, releaseCalls };
  }

  /** One `error` call as the logger received it. */
  interface LoggedError {
    msg: string;
    err: unknown;
  }

  /** A logger that records every call and, when asked to, throws from `error` after recording. */
  class RecordingLogger implements Logger {
    readonly infos: Array<{ msg: string; fields: LogFields | undefined }> = [];

    readonly errors: LoggedError[] = [];

    constructor(private readonly errorThrows: boolean) {}

    info(msg: string, fields?: LogFields): void {
      this.infos.push({ msg, fields });
    }

    error(msg: string, err?: unknown): void {
      this.errors.push({ msg, err });
      if (this.errorThrows) {
        throw new Error('log sink failed');
      }
    }
  }

  let dir: string;
  let migrationError: Error;
  let unlockError: Error;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'migrate-runner-'));
    migrationError = new Error('syntax error at or near "CREATE"');
    unlockError = new Error('unlock rejected');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes the single migration file `0001_x.sql` into the temporary directory. */
  async function writeMigration(): Promise<void> {
    await writeFile(path.join(dir, `${MIGRATION_VERSION}.sql`), MIGRATION_SQL, 'utf8');
  }

  test.each([
    { files: 0, expected: [] },
    { files: 1, expected: [MIGRATION_VERSION] },
  ])(
    'returns the client with a plain release() after a clean run of $files file(s)',
    async ({ files, expected }) => {
      if (files === 1) {
        await writeMigration();
      }
      const db = createFakeDatabase(
        { migration: false, unlock: false },
        migrationError,
        unlockError,
      );
      const logger = new RecordingLogger(false);

      await expect(runMigrations(db.pool, logger, dir)).resolves.toEqual(expected);

      expect(db.releaseCalls).toEqual([[]]);
      expect(db.statements[0]).toBe(LOCK_SQL);
      expect(db.statements.at(-1)).toBe(UNLOCK_SQL);
      expect(logger.errors).toEqual([]);
      expect(logger.infos).toEqual([
        { msg: 'migrations applied', fields: { count: files, versions: expected.join(',') } },
      ]);
    },
  );

  test.each([{ loggerThrows: true }, { loggerThrows: false }])(
    'destroys the connection once and keeps the applied list when the unlock fails ' +
      '(logger throws: $loggerThrows)',
    async ({ loggerThrows }) => {
      await writeMigration();
      const db = createFakeDatabase(
        { migration: false, unlock: true },
        migrationError,
        unlockError,
      );
      const logger = new RecordingLogger(loggerThrows);

      await expect(runMigrations(db.pool, logger, dir)).resolves.toEqual([MIGRATION_VERSION]);

      expect(db.releaseCalls).toEqual([[true]]);
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0]?.msg).toBe('migration unlock failed');
      expect(logger.errors[0]?.err).toBe(unlockError);
    },
  );

  test.each([{ loggerThrows: true }, { loggerThrows: false }])(
    'destroys the connection once and rethrows the original migration error when the unlock ' +
      'also fails (logger throws: $loggerThrows)',
    async ({ loggerThrows }) => {
      await writeMigration();
      const db = createFakeDatabase(
        { migration: true, unlock: true },
        migrationError,
        unlockError,
      );
      const logger = new RecordingLogger(loggerThrows);

      await expect(runMigrations(db.pool, logger, dir)).rejects.toBe(migrationError);

      expect(db.releaseCalls).toEqual([[true]]);
      expect(db.statements).toContain('ROLLBACK');
      expect(db.statements.at(-1)).toBe(UNLOCK_SQL);
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0]?.msg).toBe('migration unlock failed');
      expect(logger.errors[0]?.err).toBe(unlockError);
      expect(logger.infos).toEqual([]);
    },
  );

  test(
    'survives a connection the server ends mid-migration, rejects with the emitted error as ' +
      'cause and destroys the connection',
    async () => {
      await writeMigration();
      const terminated = Object.assign(
        new Error('terminating connection due to administrator command'),
        { code: '57P01' },
      );
      const db = createFakeDatabase(
        { migration: false, unlock: false, connectionLost: terminated },
        migrationError,
        unlockError,
      );
      const logger = new RecordingLogger(false);

      const failure: unknown = await runMigrations(db.pool, logger, dir).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(DatabaseUnavailableError);
      expect(failure instanceof Error ? failure.cause : undefined).toBe(terminated);
      expect(db.releaseCalls).toEqual([[true]]);
      expect(db.client.listenerCount('error')).toBe(0);
      expect(db.statements.slice(-2)).toEqual(['ROLLBACK', UNLOCK_SQL]);
      expect(logger.infos).toEqual([]);
    },
  );
});

describe('migrate CLI main', () => {
  /** The role name as PostgreSQL quotes it in messages: percent-decoded. */
  const EMAIL_ROLE = 'alice@example.com';

  /** The same role name as written in a connection string. */
  const ENCODED_ROLE = 'alice%40example.com';

  /** Assembled at run time, so no connection string with a literal password sits in the source. */
  const PASSWORD = ['plain', 'test', 'word'].join('');

  /** Host, port and database of every test URL; no connection is ever opened to it. */
  const DATABASE = 'localhost:5432/tasktracker_test';

  const MARKER = '[redacted]';

  /** A driver error shaped like the one `pg` raises when password authentication fails. */
  function authFailure(role: string): Error {
    return Object.assign(new Error(`password authentication failed for user "${role}"`), {
      name: 'error',
      code: '28P01',
    });
  }

  const originalEnv = process.env;
  let chunks: string[];
  let stdoutWrite: jest.SpiedFunction<typeof process.stdout.write>;
  let mockedRunMigrations: jest.SpiedFunction<typeof migrateModule.runMigrations>;

  /** Everything written to standard output since the test began. */
  function capturedText(): string {
    return chunks.join('');
  }

  /** The captured output parsed as JSON lines. */
  function capturedEntries(): Record<string, unknown>[] {
    return capturedText()
      .split('\n')
      .filter((line) => line !== '')
      .map((line): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('migrate-cli test: a log line is not a JSON object');
        }
        return parsed as Record<string, unknown>;
      });
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    chunks = [];
    // A spy restored after each test rather than a module mock, which would replace the runner
    // for every suite in this file: the schema suites run the real one. It resolves with nothing
    // applied unless a test gives it another implementation, so no test here reaches a database.
    mockedRunMigrations = jest.spyOn(migrateModule, 'runMigrations').mockResolvedValue([]);
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
  });

  afterEach(() => {
    process.env = originalEnv;
    stdoutWrite.mockRestore();
    mockedRunMigrations.mockRestore();
    // main() reports through process.exitCode; left set, it would become Jest's own exit code.
    process.exitCode = undefined;
  });

  test.each([
    ['user-info part', `postgres://${ENCODED_ROLE}:${PASSWORD}@${DATABASE}`],
    [
      'user and password query parameters',
      `postgres://${DATABASE}?user=${ENCODED_ROLE}&password=${PASSWORD}`,
    ],
  ])(
    'redacts the user name and password given in the %s, keeping the error code',
    async (_form: string, databaseUrl: string): Promise<void> => {
      process.env.DATABASE_URL = databaseUrl;
      mockedRunMigrations.mockImplementation(
        async (_pool: Pool, logger: Logger): Promise<string[]> => {
          logger.error('migration unlock failed', authFailure(EMAIL_ROLE));
          throw authFailure(EMAIL_ROLE);
        },
      );

      await runMigrateCli();

      expect(process.exitCode).toBe(1);
      const entries = capturedEntries();
      expect(entries.map((entry) => entry.msg)).toEqual([
        'migration unlock failed',
        'migration failed',
      ]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          level: 'error',
          err: {
            name: 'error',
            code: '28P01',
            message: `password authentication failed for user "${MARKER}"`,
            stack: expect.stringContaining(MARKER),
          },
        });
      }
      const text = capturedText();
      expect(text).not.toContain(EMAIL_ROLE);
      expect(text).not.toContain(ENCODED_ROLE);
      expect(text).not.toContain(PASSWORD);
    },
  );

  test('redacts values only, so a user name equal to a log key keeps the line intact', async () => {
    process.env.DATABASE_URL = `postgres://level:${PASSWORD}@${DATABASE}`;
    mockedRunMigrations.mockRejectedValue(authFailure('level'));

    await runMigrateCli();

    expect(process.exitCode).toBe(1);
    expect(capturedEntries()).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'migration failed',
        err: expect.objectContaining({
          code: '28P01',
          message: `password authentication failed for user "${MARKER}"`,
        }),
      }),
    ]);
  });

  test.each([
    ['the level, the error name and the error code', 'error', '28P01'],
    ['the message text', 'migration', PASSWORD],
  ])(
    'redacts only the error text, so credentials equal to %s keep them intact',
    async (_collision: string, user: string, password: string): Promise<void> => {
      process.env.DATABASE_URL = `postgres://${user}:${password}@${DATABASE}`;
      mockedRunMigrations.mockRejectedValue(authFailure(user));

      await runMigrateCli();

      expect(process.exitCode).toBe(1);
      expect(capturedEntries()).toEqual([
        expect.objectContaining({
          level: 'error',
          msg: 'migration failed',
          err: expect.objectContaining({
            name: 'error',
            code: '28P01',
            message: `password authentication failed for user "${MARKER}"`,
            stack: expect.stringContaining(`for user "${MARKER}"`),
          }),
        }),
      ]);
    },
  );

  test('forwards a line that holds no credential unchanged and exits 0', async () => {
    process.env.DATABASE_URL = `postgres://${ENCODED_ROLE}:${PASSWORD}@${DATABASE}`;
    mockedRunMigrations.mockImplementation(
      async (_pool: Pool, logger: Logger): Promise<string[]> => {
        logger.info('migrations applied', { count: 1, versions: '0001_create_users' });
        return ['0001_create_users'];
      },
    );

    await runMigrateCli();

    expect(process.exitCode).toBe(0);
    expect(capturedEntries()).toEqual([
      {
        time: expect.any(String),
        level: 'info',
        msg: 'migrations applied',
        count: 1,
        versions: '0001_create_users',
      },
    ]);
  });

  test('logs only the fixed configuration message when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;

    await runMigrateCli();

    expect(process.exitCode).toBe(1);
    expect(mockedRunMigrations).not.toHaveBeenCalled();
    expect(capturedEntries()).toEqual([
      {
        time: expect.any(String),
        level: 'error',
        msg: 'DATABASE_URL must be a postgres:// connection string',
      },
    ]);
  });

  describe('command-line arguments', () => {
    /** A connection string with its password, as a user might mistype it onto the command line. */
    const URL_ARGUMENT = `postgres://${ENCODED_ROLE}:${PASSWORD}@${DATABASE}`;

    let createPoolSpy: jest.SpiedFunction<typeof poolModule.createPool>;

    beforeEach(() => {
      createPoolSpy = jest.spyOn(poolModule, 'createPool');
    });

    afterEach(() => {
      createPoolSpy.mockRestore();
    });

    test.each([
      [['--help'], 'unset', undefined],
      [['-h'], 'unset', undefined],
      [['--help'], 'invalid', 'not a url'],
      [['-h'], 'invalid', 'not a url'],
      [['--help'], 'valid', URL_ARGUMENT],
    ])(
      '%j prints the usage and exits 0 without reading DATABASE_URL (%s) or connecting',
      async (args: string[], _state: string, databaseUrl: string | undefined): Promise<void> => {
        if (databaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = databaseUrl;
        }

        await runMigrateCli(args);

        expect(process.exitCode).toBe(0);
        const text = capturedText();
        expect(text).toContain('Usage: node dist/db/migrate-cli.js [--help]');
        expect(text).toContain('DATABASE_URL');
        expect(text).toContain('-h, --help');
        // Usage text only: no configuration error and no migration outcome is logged.
        expect(text).not.toContain('"level"');
        for (const line of text.split('\n')) {
          expect(line.length).toBeLessThanOrEqual(100);
        }
        expect(mockedRunMigrations).not.toHaveBeenCalled();
        expect(createPoolSpy).not.toHaveBeenCalled();
      },
    );

    test.each([
      ['an unknown option', ['--bogus'], '--bogus'],
      ['a positional connection string', [URL_ARGUMENT], URL_ARGUMENT],
      ['an unknown option holding a connection string', [`--url=${URL_ARGUMENT}`], '--url'],
      ['a value given to --help', ['--help=1'], '--help=1'],
      ['--help with a positional argument', ['--help', 'extra'], 'extra'],
    ])(
      'rejects %s with one fixed line and exit code 2, echoing none of it',
      async (_case: string, args: string[], echoed: string): Promise<void> => {
        // Valid, so a run that read it would go on to the runner.
        process.env.DATABASE_URL = URL_ARGUMENT;

        await runMigrateCli(args);

        expect(process.exitCode).toBe(2);
        expect(capturedEntries()).toEqual([
          {
            time: expect.any(String),
            level: 'error',
            msg: 'invalid arguments; run with --help for usage',
          },
        ]);
        const text = capturedText();
        expect(text).not.toContain(echoed);
        expect(text).not.toContain(PASSWORD);
        expect(mockedRunMigrations).not.toHaveBeenCalled();
        expect(createPoolSpy).not.toHaveBeenCalled();
      },
    );
  });
});

describe('migrate CLI main and the driver PG* variables', () => {
  /** The integration database, already migrated by the global setup, so a run applies nothing. */
  const DATABASE_URL = testDatabaseUrl();

  /** The real runner, taken before any test spies on it. */
  const realRunMigrations = migrateModule.runMigrations;

  /** pg's message when SCRAM authentication starts with no password to use. */
  const NO_PASSWORD_ERROR = 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string';

  /** The session the migration run connects as, read through the CLI's own pool. */
  interface SessionRow {
    role: string;
    database: string;
    applicationName: string;
    ssl: boolean;
  }

  const SESSION_SQL =
    'SELECT current_user AS role, current_database() AS database, ' +
    "current_setting('application_name') AS \"applicationName\", " +
    '(SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl';

  const originalEnv = process.env;
  let chunks: string[];
  let home: string;

  /** The lines written to standard output since the test began, parsed. */
  function capturedEntries(): Record<string, unknown>[] {
    return chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('migrate-cli test: a log line is not a JSON object');
        }
        return parsed as Record<string, unknown>;
      });
  }

  /** The names of the environment's `PG*` variables. */
  function pgVariableNames(): string[] {
    return Object.keys(process.env).filter((name) => name.startsWith('PG'));
  }

  /** The integration database's role and password, decoded as the driver sends them. */
  function credentials(): { user: string; password: string } {
    const url = new URL(DATABASE_URL);
    return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  }

  /**
   * Writes a password file named `fileName` into the test's home directory, holding one line
   * that matches every connection, and returns its path. `:` and `\` are escaped as the format
   * requires, and the file is private, since pg ignores one its group or others can read.
   */
  async function writePgpass(fileName: string, password: string): Promise<string> {
    const file = path.join(home, fileName);
    await writeFile(file, `*:*:*:*:${password.replace(/[\\:]/g, '\\$&')}\n`, { mode: 0o600 });
    return file;
  }

  beforeEach(async () => {
    // A home directory of the test's own, so a real ~/.pgpass can never take part.
    home = await mkdtemp(path.join(tmpdir(), 'migrate-cli-home-'));
    process.env = { ...originalEnv, HOME: home };
    for (const name of pgVariableNames()) {
      delete process.env[name];
    }
    chunks = [];
    jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
  });

  afterEach(async () => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    // main() reports through process.exitCode; left set, it would become Jest's own exit code.
    process.exitCode = undefined;
    await rm(home, { recursive: true, force: true });
  });

  test('connects only as DATABASE_URL says, whatever the PG* variables hold', async () => {
    const { user } = credentials();
    const target = new URL(DATABASE_URL);
    process.env.DATABASE_URL = DATABASE_URL;
    Object.assign(process.env, {
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGUSER: 'pg_variable_role',
      PGPASSWORD: ['pg', 'variable', randomBytes(6).toString('hex')].join('-'),
      PGDATABASE: 'pg_variable_db',
      // With the server's SSL off, a driver that read this would fail to connect at all.
      PGSSLMODE: 'require',
      PGAPPNAME: 'pg-variable-app',
    });
    let session: SessionRow | undefined;
    jest
      .spyOn(migrateModule, 'runMigrations')
      .mockImplementation(async (pool: Pool, logger: Logger, dir?: string): Promise<string[]> => {
        session = (await pool.query<SessionRow>(SESSION_SQL)).rows[0];
        return realRunMigrations(pool, logger, dir);
      });

    await runMigrateCli();

    expect(capturedEntries().map((entry) => entry.msg)).toEqual(['migrations applied']);
    expect(process.exitCode).toBe(0);
    expect(session).toEqual({
      role: user,
      database: decodeURIComponent(target.pathname.slice(1)),
      applicationName: '',
      ssl: false,
    });
    expect(pgVariableNames()).toEqual([]);
    expect(process.env.DATABASE_URL).toBe(DATABASE_URL);
    expect(process.env.HOME).toBe(home);
  });

  test.each<[string, (password: string) => Promise<void>]>([
    [
      'PGPASSWORD',
      async (password) => {
        process.env.PGPASSWORD = password;
      },
    ],
    [
      'the password file PGPASSFILE names',
      async (password) => {
        process.env.PGPASSFILE = await writePgpass('named-pgpass', password);
      },
    ],
    [
      'the ~/.pgpass file',
      async (password) => {
        await writePgpass('.pgpass', password);
      },
    ],
  ])(
    'takes no password from %s when DATABASE_URL carries none, and exits 1',
    async (_source, providePassword): Promise<void> => {
      const { password } = credentials();
      const url = new URL(DATABASE_URL);
      url.password = '';
      process.env.DATABASE_URL = url.toString();
      await providePassword(password);

      await runMigrateCli();

      expect(process.exitCode).toBe(1);
      expect(capturedEntries()).toEqual([
        expect.objectContaining({
          level: 'error',
          msg: 'migration failed',
          err: expect.objectContaining({ message: NO_PASSWORD_ERROR }),
        }),
      ]);
      expect(chunks.join('')).not.toContain(password);
      expect(pgVariableNames()).toEqual([]);
    },
  );

  test.each<[string, (target: URL) => string]>([
    ['with no host, user name or database', () => 'postgres://'],
    [
      'with a host and a database but no user name',
      (target) => `postgres://${target.host}${target.pathname}`,
    ],
  ])(
    'refuses a DATABASE_URL %s although PG* variables supply the rest, and exits 1',
    async (_form, databaseUrl): Promise<void> => {
      const { user, password } = credentials();
      const target = new URL(DATABASE_URL);
      process.env.DATABASE_URL = databaseUrl(target);
      Object.assign(process.env, {
        PGHOST: target.hostname,
        PGPORT: target.port,
        PGUSER: user,
        PGPASSWORD: password,
        PGDATABASE: decodeURIComponent(target.pathname.slice(1)),
      });
      const runner = jest.spyOn(migrateModule, 'runMigrations');
      const createPoolSpy = jest.spyOn(poolModule, 'createPool');

      await runMigrateCli();

      expect(process.exitCode).toBe(1);
      expect(capturedEntries()).toEqual([
        {
          time: expect.any(String),
          level: 'error',
          msg: 'DATABASE_URL must be a postgres:// connection string',
        },
      ]);
      expect(runner).not.toHaveBeenCalled();
      expect(createPoolSpy).not.toHaveBeenCalled();
      expect(chunks.join('')).not.toContain(password);
    },
  );
});

describe('createPool connection teardown', () => {
  /**
   * How the fake server answers a start-up packet: `scram` asks for SCRAM-SHA-256 and answers the
   * client's first SASL message, so a client without a password fails on its own side; `trust`
   * accepts the client at once. Neither answers a statement, like a server that stopped
   * responding without closing its sockets.
   */
  type Handshake = 'scram' | 'trust';

  /** One connection the fake server accepted, seen from the server side. */
  interface FakeConnection {
    /** Frontend messages in arrival order: `startup`, then each message's type byte. */
    readonly received: string[];
    /** Resolves once the server-side socket has closed, with whether it closed on an error. */
    readonly closed: Promise<{ hadError: boolean }>;
    /** Whether the server-side socket has closed. */
    isClosed(): boolean;
  }

  /** How long a closed socket may take to reach the server before the test fails. */
  const PROMPT_CLOSE_MS = 1_000;

  /** How long an open socket is watched to confirm that nothing closes it. */
  const STAYS_OPEN_MS = 200;

  /** How long to wait after a close for any `error` event it could have caused. */
  const SETTLE_MS = 50;

  /** pg's message when SCRAM authentication starts with no password to use. */
  const NO_PASSWORD_ERROR = 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string';

  /** The pool's query timeout: how long pg waits for a statement's answer before giving up. */
  const QUERY_TIMEOUT_MS = 5_000;

  /**
   * How much later than the query timeout an unanswered statement may reject. A second timeout,
   * such as one for a `ROLLBACK` queued behind that statement, would exceed it.
   */
  const TIMEOUT_MARGIN_MS = 2_000;

  /** A big-endian 32-bit integer, the width of every length and code in the protocol. */
  function int32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value);
    return buffer;
  }

  /** A backend message: its type byte, its length including itself, and its body. */
  function backendMessage(type: string, body: Buffer): Buffer {
    return Buffer.concat([Buffer.from(type, 'latin1'), int32(body.length + 4), body]);
  }

  /** AuthenticationSASL offering SCRAM-SHA-256, the request a SCRAM server sends first. */
  const AUTHENTICATION_SASL = backendMessage(
    'R',
    Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0', 'latin1')]),
  );

  /** AuthenticationSASLContinue carrying a server-first message. */
  const AUTHENTICATION_SASL_CONTINUE = backendMessage(
    'R',
    Buffer.concat([int32(11), Buffer.from('r=fakenonce,s=c2FsdA==,i=4096', 'latin1')]),
  );

  /** AuthenticationOk followed by ReadyForQuery (idle), which completes a connection. */
  const AUTHENTICATED_AND_READY = Buffer.concat([
    backendMessage('R', int32(0)),
    backendMessage('Z', Buffer.from('I', 'latin1')),
  ]);

  /** Serves one accepted socket with the protocol subset `handshake` needs. */
  function serveConnection(socket: Socket, handshake: Handshake): FakeConnection {
    const received: string[] = [];
    let isClosed = false;
    const closed = new Promise<{ hadError: boolean }>((resolve) => {
      socket.once('close', (hadError: boolean): void => {
        isClosed = true;
        resolve({ hadError });
      });
    });
    // A reset from the client is recorded, so the tests' `received` and `hadError` checks fail on
    // it rather than the run failing on an unhandled `error` event.
    socket.on('error', (err: Error): void => {
      received.push(`socket error ${err.message}`);
    });

    let pending = Buffer.alloc(0);
    let typed = false;
    socket.on('data', (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        // The start-up packet has no type byte; every later frontend message starts with one.
        const headerLength = typed ? 5 : 4;
        if (pending.length < headerLength) {
          return;
        }
        const messageLength = typed ? pending.readInt32BE(1) + 1 : pending.readInt32BE(0);
        if (pending.length < messageLength) {
          return;
        }
        const type = typed ? pending.toString('latin1', 0, 1) : 'startup';
        pending = pending.subarray(messageLength);
        typed = true;
        received.push(type);

        if (type === 'startup') {
          socket.write(handshake === 'scram' ? AUTHENTICATION_SASL : AUTHENTICATED_AND_READY);
        } else if (type === 'p' && handshake === 'scram') {
          socket.write(AUTHENTICATION_SASL_CONTINUE);
        }
      }
    });

    return { received, closed, isClosed: (): boolean => isClosed };
  }

  /** A minimal PostgreSQL server on 127.0.0.1 that records what each connection receives. */
  class FakePgServer {
    private readonly connections: FakeConnection[] = [];

    private readonly sockets = new Set<Socket>();

    private readonly server: Server;

    /** Creates a server that answers every connection with `handshake`; call `listen` next. */
    constructor(handshake: Handshake) {
      this.server = createServer((socket: Socket): void => {
        this.sockets.add(socket);
        socket.once('close', (): void => {
          this.sockets.delete(socket);
        });
        this.connections.push(serveConnection(socket, handshake));
      });
    }

    /** Listens on an ephemeral port and resolves with it. */
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, '127.0.0.1', (): void => {
          this.server.off('error', reject);
          resolve();
        });
      });
      const address: AddressInfo | string | null = this.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('fake server is not listening on a TCP port');
      }
      return address.port;
    }

    /** The single connection accepted so far; throws unless exactly one was accepted. */
    onlyConnection(): FakeConnection {
      const [connection, ...others] = this.connections;
      if (connection === undefined || others.length > 0) {
        throw new Error(`fake server accepted ${this.connections.length} connections, not 1`);
      }
      return connection;
    }

    /** Destroys every open socket and stops listening. */
    async close(): Promise<void> {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        this.server.close((err?: Error): void => (err === undefined ? resolve() : reject(err)));
      });
    }
  }

  /** Resolves with `promise`'s value, or rejects once `ms` milliseconds pass first. */
  async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout((): void => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const originalEnv = process.env;
  let servers: FakePgServer[];
  let pools: Pool[];
  /** Clients this test checked out and has not released yet. */
  let unreleased: Set<PoolClient>;

  /** Starts a fake server for this test and returns a password-less URL for it. */
  async function fakeServerUrl(handshake: Handshake): Promise<[FakePgServer, string]> {
    const server = new FakePgServer(handshake);
    servers.push(server);
    const port = await server.listen();
    return [server, `postgres://alice@127.0.0.1:${port}/db`];
  }

  /** Registers a pool the moment it exists, so teardown ends it unless the test already did. */
  function registerPool(pool: Pool): Pool {
    pools.push(pool);
    return pool;
  }

  /** Registers a checked-out client, so teardown destroys it unless the test released it. */
  function registerClient(client: PoolClient): PoolClient {
    unreleased.add(client);
    return client;
  }

  /** Returns a registered client to its pool with a plain `release()`, exactly once. */
  function releaseClient(client: PoolClient): void {
    unreleased.delete(client);
    client.release();
  }

  beforeEach(() => {
    servers = [];
    pools = [];
    unreleased = new Set<PoolClient>();
    // The URL carries no password, so none may come from the environment either. createPool
    // leaves the environment to the entry points, so pg would still read PGPASSWORD here; the
    // pool's client never reads a password file, and PGPASSFILE names a missing path in case it
    // ever did. SSL stays off so the start-up packet is the first thing the fake server reads.
    process.env = {
      ...originalEnv,
      PGPASSFILE: path.join(tmpdir(), `pool-test-no-pgpass-${randomUUID()}`),
    };
    delete process.env.PGPASSWORD;
    delete process.env.PGSSLMODE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    // Every cleanup is attempted before any failure is reported, so a test that failed part-way
    // leaves no client, pool or server behind. Clients go first because a pool's `end` waits for
    // every client it handed out; one the test still holds is destroyed rather than reused.
    const failures: unknown[] = [];
    const attempt = async (cleanup: () => Promise<void> | void): Promise<void> => {
      try {
        await cleanup();
      } catch (err) {
        failures.push(err);
      }
    };
    for (const client of unreleased) {
      await attempt(() => client.release(true));
    }
    unreleased.clear();
    await Promise.all(
      pools
        .filter((pool) => !pool.ending)
        .map((pool) => attempt(() => within(pool.end(), PROMPT_CLOSE_MS, 'pool end'))),
    );
    await Promise.all(servers.map((server) => attempt(() => server.close())));
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `pool teardown: ${failures.length} cleanups failed`);
    }
  });

  test('a connection pg rejects itself closes its socket at once and logs nothing', async () => {
    const [server, url] = await fakeServerUrl('scram');
    const logger = new CaptureLogger();
    const pool = registerPool(createPool(url, logger));

    // A connect that wrongly succeeds still hands its client to teardown.
    await expect(pool.connect().then(registerClient)).rejects.toThrow(NO_PASSWORD_ERROR);

    const connection = server.onlyConnection();
    // Without the teardown the socket would stay open until the server's authentication timeout.
    await expect(within(connection.closed, PROMPT_CLOSE_MS, 'socket close')).resolves.toEqual({
      hadError: false,
    });
    // A plain end of file: no Terminate message was sent in the middle of authentication.
    expect(connection.received).toEqual(['startup', 'p']);

    await delay(SETTLE_MS);
    await expect(pool.end()).resolves.toBeUndefined();
    expect(logger.entries()).toEqual([]);
  });

  test('a connected client keeps its socket, also after a refused second connect', async () => {
    const [server, url] = await fakeServerUrl('trust');
    const logger = new CaptureLogger();
    const pool = registerPool(createPool(url, logger));

    const client = registerClient(await pool.connect());
    let connection: FakeConnection;
    try {
      connection = server.onlyConnection();
      await delay(STAYS_OPEN_MS);
      expect(connection.isClosed()).toBe(false);

      // pg refuses to reuse a client; that refusal must not close the live socket.
      await expect(client.connect()).rejects.toThrow('Client has already been connected');
      await delay(STAYS_OPEN_MS);
      expect(connection.isClosed()).toBe(false);
    } finally {
      releaseClient(client);
    }

    await delay(STAYS_OPEN_MS);
    expect(connection.isClosed()).toBe(false);

    await pool.end();
    await expect(within(connection.closed, PROMPT_CLOSE_MS, 'socket close')).resolves.toEqual({
      hadError: false,
    });
    expect(connection.received).toEqual(['startup', 'X']);
    expect(logger.entries()).toEqual([]);
  });

  test.each<[string, (pool: Pool) => Promise<unknown>]>([
    ['a statement on the pool', (pool) => query(pool, 'SELECT 1', [])],
    [
      'a statement on a checked-out client',
      async (pool) => {
        const client = registerClient(await checkOut(pool));
        try {
          return await query(client, 'SELECT 1', []);
        } finally {
          // A plain release: the recorded read timeout alone must make it destroy the connection.
          releaseClient(client);
        }
      },
    ],
    ['a transaction', (pool) => withTransaction(pool, (client) => query(client, 'SELECT 1', []))],
  ])(
    '%s left unanswered rejects as unavailable within one query timeout and destroys its ' +
      'connection',
    async (_case, run): Promise<void> => {
      const [server, url] = await fakeServerUrl('trust');
      const logger = new CaptureLogger();
      const pool = registerPool(createPool(url, logger));

      const started = performance.now();
      const failure: unknown = await run(pool).then(
        () => undefined,
        (err: unknown) => err,
      );
      const elapsedMs = performance.now() - started;

      expect(failure).toBeInstanceOf(DatabaseUnavailableError);
      expect(failure instanceof Error ? failure.cause : undefined).toMatchObject({
        message: 'Query read timeout',
      });
      expect(elapsedMs).toBeLessThan(QUERY_TIMEOUT_MS + TIMEOUT_MARGIN_MS);
      const connection = server.onlyConnection();
      await expect(within(connection.closed, PROMPT_CLOSE_MS, 'socket close')).resolves.toEqual({
        hadError: false,
      });
      // Only the first statement was sent: no `ROLLBACK` followed it, and no Terminate either,
      // since the connection was destroyed rather than ended.
      expect(connection.received).toEqual(['startup', 'Q']);
      expect(pool.totalCount).toBe(0);
      expect(logger.entries()).toEqual([]);
    },
  );
});

/** Clock reading during every logger test, so whole lines can be compared byte for byte. */
const LOG_NOW = '2026-01-02T03:04:05.678Z';

/** The only keys a serialized error may carry. */
const LOG_ERR_KEYS: readonly string[] = ['name', 'message', 'code', 'stack'];

/** A logger writing into memory, and the text it has written so far. */
interface LogCapture {
  logger: Logger;
  text(): string;
}

/** Creates a logger over a synchronous in-memory stream, with `options` when given. */
function captureLog(options?: LoggerOptions): LogCapture {
  const chunks: string[] = [];
  const sink = new Writable({
    write(
      chunk: unknown,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    },
  });
  return { logger: createLogger(sink, options), text: () => chunks.join('') };
}

/** Asserts that `text` is exactly one newline-terminated line and returns it parsed. */
function parseOnlyLogLine(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('');
  const parsed: unknown = JSON.parse(lines[0] ?? '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('log line is not a JSON object');
  }
  return { ...parsed };
}

/** Throws from a getter or a proxy trap. */
function hostileRead(): never {
  throw new Error('hostile read');
}

/** Returns a plain object that contains itself, which `JSON.stringify` rejects. */
function cyclicObject(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

/** Returns `new Error('original failure')` with its `key` property redefined. */
function errorWith(key: string, descriptor: PropertyDescriptor, cause?: unknown): Error {
  const err =
    cause === undefined
      ? new Error('original failure')
      : new Error('original failure', { cause });
  Object.defineProperty(err, key, { configurable: true, ...descriptor });
  return err;
}

/** Returns an `Error` proxy that is already revoked, so every operation on it throws. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable(new Error('original failure'), {});
  revoke();
  return proxy;
}

/**
 * Registers the hooks of one logger describe: the clock fixed at {@link LOG_NOW} for each test,
 * then real timers and every spy restored after it. Each logger describe calls it itself, so the
 * pool, runner and schema suites in this file keep real timers.
 */
function useLogClock(): void {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(LOG_NOW) });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
}

describe('createLogger error()', () => {
  useLogClock();

  test.each<[string, () => unknown, Record<string, unknown>]>([
    [
      'throwing code getter',
      () => errorWith('code', { get: hostileRead }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'throwing code getter, readable cause.code',
      () => errorWith('code', { get: hostileRead }, { code: 'ECONNREFUSED' }),
      {
        name: 'Error',
        message: 'original failure',
        code: 'ECONNREFUSED',
        stack: expect.any(String),
      },
    ],
    [
      'throwing cause getter',
      () => errorWith('cause', { get: hostileRead }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'throwing cause.code getter',
      () =>
        new Error('original failure', {
          cause: Object.defineProperty({}, 'code', { get: hostileRead }),
        }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'proxy whose has trap throws',
      () => new Proxy(new Error('original failure'), { has: hostileRead }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'proxy whose get trap throws',
      () => new Proxy(new Error('original failure'), { get: hostileRead }),
      { message: '[unreadable message]' },
    ],
    [
      'proxy whose getPrototypeOf trap throws',
      () => new Proxy(new Error('original failure'), { getPrototypeOf: hostileRead }),
      { message: 'Error: original failure' },
    ],
    ['revoked proxy', revokedProxy, { message: '[unprintable object]' }],
    [
      'number name',
      () => errorWith('name', { value: 42 }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    [
      'cyclic name',
      () => errorWith('name', { value: cyclicObject() }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    [
      'BigInt name',
      () => errorWith('name', { value: 10n }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    // V8 formats `stack` on its first read from `name` and `message`. Where either throws when
    // read or converted to text (here and in two `message` rows below), so does reading
    // `stack`, and it is omitted as well.
    [
      'throwing name getter',
      () => errorWith('name', { get: hostileRead }),
      { message: 'original failure' },
    ],
    [
      'cyclic message',
      () => errorWith('message', { value: cyclicObject() }),
      { name: 'Error', message: '[object Object]', stack: expect.any(String) },
    ],
    [
      'BigInt message',
      () => errorWith('message', { value: 10n }),
      { name: 'Error', message: '10', stack: expect.any(String) },
    ],
    [
      'prototype-less object message',
      () => errorWith('message', { value: Object.create(null) }),
      { name: 'Error', message: '[unprintable object]' },
    ],
    [
      'throwing message getter',
      () => errorWith('message', { get: hostileRead }),
      { name: 'Error', message: '[unreadable message]' },
    ],
    [
      'cyclic stack',
      () => errorWith('stack', { value: cyclicObject() }),
      { name: 'Error', message: 'original failure' },
    ],
    [
      'throwing stack getter',
      () => errorWith('stack', { get: hostileRead }),
      { name: 'Error', message: 'original failure' },
    ],
    [
      'BigInt code',
      () => errorWith('code', { value: 10n }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'NaN code',
      () => errorWith('code', { value: Number.NaN }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'Infinity code, readable cause.code',
      () => errorWith('code', { value: Number.POSITIVE_INFINITY }, { code: '57P01' }),
      { name: 'Error', message: 'original failure', code: '57P01', stack: expect.any(String) },
    ],
    [
      'cyclic cause',
      () => errorWith('cause', { value: cyclicObject() }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
  ])('reduces an error with a %s to primitives in one line', (_label, makeErr, expected) => {
    const { logger, text } = captureLog();
    const err = makeErr();

    expect(() => logger.error('failure', err)).not.toThrow();

    const entry = parseOnlyLogLine(text());
    expect(Object.keys(entry)).toEqual(['time', 'level', 'msg', 'err']);
    const reduced = entry.err;
    if (typeof reduced !== 'object' || reduced === null || Array.isArray(reduced)) {
      throw new Error('err is not a JSON object');
    }
    const reducedEntries: [string, unknown][] = Object.entries(reduced);
    for (const [key, value] of reducedEntries) {
      expect(LOG_ERR_KEYS).toContain(key);
      expect(
        typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
      ).toBe(true);
    }
    expect(reduced).toEqual(expected);
  });

  test.each<[string, unknown]>([
    ['cyclic object', cyclicObject()],
    ['BigInt', 10n],
    ['object whose toJSON throws', { toJSON: hostileRead }],
  ])('replaces a cast %s msg that cannot be serialized', (_label, msg) => {
    const { logger, text } = captureLog();
    const err = errorWith('stack', { value: 'Error: original failure\n    at handler' });

    expect(() => logger.error(msg as string, err, { method: 'GET' })).not.toThrow();

    // Only the guaranteed primitives survive: the caller's fields are dropped with the msg.
    expect(text()).toBe(
      `${JSON.stringify({
        time: LOG_NOW,
        level: 'error',
        msg: '[unserializable msg]',
        err: {
          name: 'Error',
          message: 'original failure',
          stack: 'Error: original failure\n    at handler',
        },
      })}\n`,
    );
  });

  test('writes time, level and a fixed msg when the reduced line cannot be serialized', () => {
    const { logger, text } = captureLog();
    // Stands in for output longer than the engine's maximum string length.
    jest
      .spyOn(JSON, 'stringify')
      .mockImplementationOnce(() => {
        throw new RangeError('Invalid string length');
      })
      .mockImplementationOnce(() => {
        throw new RangeError('Invalid string length');
      });

    expect(() => logger.error('migration failed', new Error('original failure'))).not.toThrow();

    expect(text()).toBe(`{"time":"${LOG_NOW}","level":"error","msg":"[unserializable msg]"}\n`);
  });
});

describe('createLogger fields', () => {
  useLogClock();

  test.each<[string, () => unknown, string]>([
    [
      'a throwing getter drops that field only',
      () =>
        Object.defineProperty({ method: 'GET' }, 'path', { enumerable: true, get: hostileRead }),
      `{"time":"${LOG_NOW}","level":"info","msg":"event","method":"GET"}\n`,
    ],
    [
      'a proxy whose ownKeys trap throws drops every field',
      () => new Proxy({ method: 'GET' }, { ownKeys: hostileRead }),
      `{"time":"${LOG_NOW}","level":"info","msg":"event"}\n`,
    ],
    [
      'a proxy whose get trap throws drops every field',
      () => new Proxy({ method: 'GET', path: '/tasks' }, { get: hostileRead }),
      `{"time":"${LOG_NOW}","level":"info","msg":"event"}\n`,
    ],
    [
      'a revoked proxy drops every field',
      revokedProxy,
      `{"time":"${LOG_NOW}","level":"info","msg":"event"}\n`,
    ],
  ])('%s', (_label, makeFields, expected) => {
    const { logger, text } = captureLog();
    const fields = makeFields() as LogFields;

    expect(() => logger.info('event', fields)).not.toThrow();

    expect(text()).toBe(expected);
  });
});

describe('createLogger ordinary inputs', () => {
  useLogClock();

  /** A pg driver error: its `detail` and `query` carry row values and SQL text. */
  function driverError(message: string, code: string): Error {
    return Object.assign(new Error(message), {
      code,
      detail: 'Key (lower(email))=(alice@example.com) already exists.',
      query: 'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      stack: `Error: ${message}\n    at driver`,
    });
  }

  /** `DatabaseUnavailableError` wrapping a driver error, as the query helper builds it. */
  function unavailable(): Error {
    const err = new DatabaseUnavailableError('Database unavailable', {
      cause: driverError('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    });
    err.stack = 'DatabaseUnavailableError: Database unavailable\n    at query';
    return err;
  }

  test.each<[string, (logger: Logger) => void, Record<string, unknown>]>([
    [
      'info with fields',
      (logger) => logger.info('server listening', { port: 3000 }),
      { time: LOG_NOW, level: 'info', msg: 'server listening', port: 3000 },
    ],
    [
      'error without err',
      (logger) => logger.error('configuration invalid'),
      { time: LOG_NOW, level: 'error', msg: 'configuration invalid' },
    ],
    [
      'DatabaseUnavailableError reporting cause.code, with request fields',
      (logger) =>
        logger.error('database unavailable', unavailable(), { method: 'GET', path: '/tasks' }),
      {
        time: LOG_NOW,
        level: 'error',
        msg: 'database unavailable',
        method: 'GET',
        path: '/tasks',
        err: {
          name: 'DatabaseUnavailableError',
          message: 'Database unavailable',
          code: 'ECONNREFUSED',
          stack: 'DatabaseUnavailableError: Database unavailable\n    at query',
        },
      },
    ],
    [
      'driver error with its own code',
      (logger) =>
        logger.error(
          'unexpected error',
          driverError('duplicate key value violates unique constraint', '23505'),
        ),
      {
        time: LOG_NOW,
        level: 'error',
        msg: 'unexpected error',
        err: {
          name: 'Error',
          message: 'duplicate key value violates unique constraint',
          code: '23505',
          stack: 'Error: duplicate key value violates unique constraint\n    at driver',
        },
      },
    ],
    [
      'thrown non-Error value',
      (logger) => logger.error('purge failed', 'socket closed'),
      { time: LOG_NOW, level: 'error', msg: 'purge failed', err: { message: 'socket closed' } },
    ],
    [
      'reserved field names',
      (logger) =>
        logger.error('purge failed', undefined, {
          time: 'forged',
          level: 'forged',
          msg: 'forged',
          err: 'forged',
          method: 'POST',
        }),
      { time: LOG_NOW, level: 'error', msg: 'purge failed', method: 'POST' },
    ],
  ])('writes %s exactly as before', (_label, call, expected) => {
    const { logger, text } = captureLog();

    call(logger);

    // `expected` lists the keys in the logger's fixed order, so this compares bytes and order.
    expect(text()).toBe(`${JSON.stringify(expected)}\n`);
  });
});

describe('createLogger redaction', () => {
  useLogClock();

  /** A database role name as PostgreSQL quotes it in messages: percent-decoded. */
  const ROLE = 'alice@example.com';
  /** The same role name as written in a connection string. */
  const ENCODED_ROLE = 'alice%40example.com';
  /** Assembled at run time, so no literal password sits in the source. */
  const PASSWORD = ['plain', 'test', 'word'].join('');
  const MARKER = '[redacted]';

  /** A driver error shaped like the one `pg` raises, with `name`, `code` and a fixed stack. */
  function driverFailure(message: string): Error {
    return Object.assign(new Error(message), {
      name: 'error',
      code: '28P01',
      stack: `error: ${message}\n    at connect`,
    });
  }

  /** The line `logger.error('migration failed', driverFailure(message))` is expected to write. */
  function migrationFailedLine(message: string): Record<string, unknown> {
    return {
      time: LOG_NOW,
      level: 'error',
      msg: 'migration failed',
      err: { name: 'error', message, code: '28P01', stack: `error: ${message}\n    at connect` },
    };
  }

  test.each<[string, RedactedCredentials, (logger: Logger) => void, Record<string, unknown>]>([
    [
      'the user name, as quoted and as written, and the password in the message and stack',
      { userNames: [ROLE, ENCODED_ROLE], passwords: [PASSWORD] },
      (logger) =>
        logger.error(
          'migration failed',
          driverFailure(
            `authentication failed for user "${ROLE}" (postgres://${ENCODED_ROLE}:${PASSWORD}@h/d)`,
          ),
        ),
      migrationFailedLine(
        `authentication failed for user "${MARKER}" (postgres://${MARKER}:${MARKER}@h/d)`,
      ),
    ],
    [
      'a user name that contains another whole, whatever order they are given in',
      { userNames: ['alice', ROLE] },
      (logger) =>
        logger.error(
          'migration failed',
          driverFailure(`failed for user "${ROLE}" (postgres://alice@h/d)`),
        ),
      migrationFailedLine(`failed for user "${MARKER}" (postgres://${MARKER}@h/d)`),
    ],
    [
      'a password that contains another whole, whatever order they are given in',
      { passwords: ['pass', 'pass word'] },
      (logger) =>
        logger.error('migration failed', driverFailure("password='pass word' password=pass")),
      migrationFailedLine(`password='${MARKER}' password=${MARKER}`),
    ],
    [
      // A second pass would match the marker and the word after it, which form the longer value.
      'in a single pass, never inside a marker it has just written',
      { passwords: ['secret', `${MARKER} word`] },
      (logger) => logger.error('migration failed', driverFailure("password='secret word'")),
      migrationFailedLine(`password='${MARKER} word'`),
    ],
    [
      'values holding regular-expression metacharacters as literal text only',
      { passwords: ['.', '(w)+', 'a$&b'] },
      (logger) =>
        logger.error(
          'migration failed',
          driverFailure("//u:.@h //u:x@h password=(w)+ password=ww password='a$&b'"),
        ),
      migrationFailedLine(
        `//u:${MARKER}@h //u:x@h password=${MARKER} password=ww password='${MARKER}'`,
      ),
    ],
    [
      'only the error text, so values equal to the time, level, msg, fields, name or code stay',
      { passwords: [LOG_NOW, 'error', 'migration failed', '28P01', 'GET', '/tasks'] },
      (logger) =>
        logger.error(
          'migration failed',
          driverFailure("password=error, password='migration failed'"),
          { method: 'GET', path: '/tasks' },
        ),
      {
        time: LOG_NOW,
        level: 'error',
        msg: 'migration failed',
        method: 'GET',
        path: '/tasks',
        err: {
          name: 'error',
          message: `password=${MARKER}, password='${MARKER}'`,
          code: '28P01',
          // The stack's `name: message` head is driver text too, but not a credential context.
          stack: `error: password=${MARKER}, password='${MARKER}'\n    at connect`,
        },
      },
    ],
    [
      'the message of a thrown non-Error value',
      { passwords: [PASSWORD] },
      (logger) => logger.error('purge failed', `socket closed for postgres://u:${PASSWORD}@h`),
      {
        time: LOG_NOW,
        level: 'error',
        msg: 'purge failed',
        err: { message: `socket closed for postgres://u:${MARKER}@h` },
      },
    ],
    [
      'nothing from an info line, whose fields the code produces',
      { userNames: [ROLE], passwords: [PASSWORD] },
      (logger) =>
        logger.info('migrations applied', {
          count: 1,
          versions: `user "${ROLE}" password=${PASSWORD}`,
        }),
      {
        time: LOG_NOW,
        level: 'info',
        msg: 'migrations applied',
        count: 1,
        versions: `user "${ROLE}" password=${PASSWORD}`,
      },
    ],
  ])('redacts %s', (_label, redact, call, expected) => {
    const { logger, text } = captureLog({ redact });

    call(logger);

    // `expected` lists the keys in the logger's fixed order, so this compares bytes and order.
    expect(text()).toBe(`${JSON.stringify(expected)}\n`);
  });

  // A password is redacted only where it stands as the credential, so a password that is also a
  // module file name, a directory of every stack path or a word of a driver message leaves them
  // readable. Each text is the error's message, which the stack repeats, so both are compared.
  test.each<[string, string]>([
    ['index', 'at Pool.connect (/app/node_modules/pg-pool/index.js:45:11)'],
    ['x', 'at Pool.connect (/app/node_modules/pg-pool/index.js:45:11)'],
    ['app', 'at toDatabaseError (/home/node/app/dist/db/query.js:152:12)'],
    ['password', 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'],
  ])('given the password %s, keeps "%s" and redacts it as the credential', (password, kept) => {
    const contexts = (value: string): string =>
      `postgres://u:${value}@h/d password=${value} {"password":"${value}"} PASSWORD '${value}'`;
    const { logger, text } = captureLog({ redact: { passwords: [password] } });

    logger.error('migration failed', driverFailure(`${kept} ${contexts(password)}`));

    expect(text()).toBe(`${JSON.stringify(migrationFailedLine(`${kept} ${contexts(MARKER)}`))}\n`);
  });

  // Each credential is redacted only where it stands as one: a password in a URL's user-info or
  // as the whole value of a password setting, a user name in a URL, a quoted role or a `user=`
  // setting. So a short or common value leaves a stack path, a word or a database name holding
  // the same characters readable. Each text is the error's message, which the stack repeats, so
  // both are compared.
  test.each<[string, RedactedCredentials, string, string]>([
    [
      "a password, in a URL's user-info or as the whole value of a setting in any of its forms",
      { passwords: ['x'] },
      'Password=x, PASSWORD: x; (password=x) {password=x} "password": "x" password \'x\' ' +
        '?password=x&a=1 u:x@h password=xy password x PASSWORD "x" password=x',
      `Password=${MARKER}, PASSWORD: ${MARKER}; (password=${MARKER}) {password=${MARKER}} ` +
        `"password": "${MARKER}" password '${MARKER}' ?password=${MARKER}&a=1 u:${MARKER}@h ` +
        `password=xy password x PASSWORD "x" password=${MARKER}`,
    ],
    [
      'a user name, as a directory of every stack path',
      { userNames: ['app'] },
      'at toDatabaseError (/home/node/app/dist/db/query.js:152:12)',
      'at toDatabaseError (/home/node/app/dist/db/query.js:152:12)',
    ],
    [
      'a one-letter user name, inside a word',
      { userNames: ['u'] },
      'Database unavailable',
      'Database unavailable',
    ],
    [
      'a user name, as the quoted database name',
      { userNames: ['tasktracker'] },
      'database "tasktracker" does not exist',
      'database "tasktracker" does not exist',
    ],
    [
      'a user name, as the start of the quoted database name',
      { userNames: ['tasktracker'] },
      'database "tasktracker_c9_does_not_exist" does not exist',
      'database "tasktracker_c9_does_not_exist" does not exist',
    ],
    [
      'an email-shaped user name, as the role PostgreSQL quotes',
      { userNames: [ROLE] },
      `password authentication failed for user "${ROLE}"`,
      `password authentication failed for user "${MARKER}"`,
    ],
    [
      'a user name, as a quoted role but not inside a longer one',
      { userNames: ['tasktracker'] },
      'role "tasktracker" does not exist; role "tasktracker2" neither',
      `role "${MARKER}" does not exist; role "tasktracker2" neither`,
    ],
    [
      'a user name, in the user-info part of a URL but not its path',
      { userNames: [ENCODED_ROLE, 'u'] },
      `postgres://${ENCODED_ROLE}@h/d and postgres://u:p@h/u`,
      `postgres://${MARKER}@h/d and postgres://${MARKER}:p@h/u`,
    ],
    [
      'a user name, as the whole value of a user= setting',
      { userNames: ['alice'] },
      "user=alice dbname=alice user='alice' ?user=alice&x=1 user=alice.smith",
      `user=${MARKER} dbname=alice user='${MARKER}' ?user=${MARKER}&x=1 user=alice.smith`,
    ],
  ])('given %s, redacts only the credential', (_label, redact, input, expected) => {
    const { logger, text } = captureLog({ redact });

    logger.error('migration failed', driverFailure(input));

    expect(text()).toBe(`${JSON.stringify(migrationFailedLine(expected))}\n`);
  });

  test.each<[string, LoggerOptions]>([
    ['an empty options object', {}],
    ['no credentials', { redact: {} }],
    ['empty credential lists', { redact: { userNames: [], passwords: [] } }],
    ['only empty strings to redact', { redact: { userNames: ['', ''], passwords: [''] } }],
    ['values that never occur', { redact: { userNames: ['absent'], passwords: ['absent-value'] } }],
    [
      'credentials that occur only as words',
      { redact: { userNames: ['socket', 'failed'], passwords: ['socket', 'error', 'user'] } },
    ],
  ])('writes exactly the lines of a logger without options given %s', (_label, options) => {
    const calls = (logger: Logger): void => {
      logger.info('server listening', { port: 3000 });
      logger.error('configuration invalid');
      logger.error('migration failed', driverFailure(`failed for user "${ROLE}"`));
      logger.error('purge failed', 'socket closed', { method: 'GET' });
    };
    const plain = captureLog();
    const configured = captureLog(options);

    calls(plain.logger);
    calls(configured.logger);

    expect(configured.text()).toBe(plain.text());
    expect(configured.text().split('\n')).toHaveLength(5);
  });

  test('writes a fixed message and drops the stack when a replacement fails', () => {
    const { logger, text } = captureLog({ redact: { passwords: [PASSWORD] } });
    const err = driverFailure(`failed for postgres://u:${PASSWORD}@h`);
    // Stands in for a replacement whose result exceeds the engine's maximum string length. The
    // spy is removed before any assertion runs, since the matchers replace text themselves.
    const replace = jest.spyOn(String.prototype, 'replace').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    let thrown: unknown = null;
    try {
      logger.error('migration failed', err);
    } catch (caught) {
      thrown = caught;
    } finally {
      replace.mockRestore();
    }

    expect(thrown).toBeNull();

    expect(text()).toBe(
      `${JSON.stringify({
        time: LOG_NOW,
        level: 'error',
        msg: 'migration failed',
        err: { name: 'error', message: '[unredactable message]', code: '28P01' },
      })}\n`,
    );
  });
});

/** Every migration version in application order: each file's name without `.sql`. */
const ALL_VERSIONS: readonly string[] = [
  '0001_create_users',
  '0002_create_sessions',
  '0003_create_tasks',
  '0004_create_login_attempts',
];

/** Every index the schema plan's index table names. */
const PLANNED_INDEXES: readonly string[] = [
  'users_email_lower_key',
  'sessions_pkey',
  'sessions_user_id_idx',
  'sessions_expires_at_idx',
  'tasks_owner_due_idx',
  'tasks_owner_completed_idx',
  'tasks_owner_created_idx',
  'login_attempts_email_failed_idx',
  'login_attempts_failed_at_idx',
];

/** SQLSTATE `check_violation`. */
const CHECK_VIOLATION = '23514';

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Base instant of every fixture timestamp, as epoch milliseconds so no `Date` is shared. */
const BASE_TIME_MS = Date.parse('2026-10-21T09:00:00.000Z');

const MINUTE_MS = 60_000;

/** The absolute session lifetime the `sessions_expires_at_check` constraint allows. */
const EIGHT_HOURS_MS = 8 * 60 * MINUTE_MS;

/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const ASTRAL_CHARACTER = '\u{1F600}';

/** Message the runner logs once per run, also when nothing was pending. */
const MIGRATIONS_APPLIED = 'migrations applied';

/** Message the runner logs when releasing its advisory lock fails. */
const MIGRATION_UNLOCK_FAILED = 'migration unlock failed';

/** Returns a fresh `Date` `offsetMs` after the base fixture instant. */
function at(offsetMs = 0): Date {
  return new Date(BASE_TIME_MS + offsetMs);
}

/** Returns an ASCII email of exactly `length` characters ending in `@example.com`. */
function emailOfLength(length: number): string {
  const domain = '@example.com';
  return `${'a'.repeat(length - domain.length)}${domain}`;
}

/** A row of `pg_indexes`. */
interface IndexRow {
  indexname: string;
  indexdef: string;
}

/** A row holding one migration version. */
interface VersionRow {
  version: string;
}

/** A migration version with the number of times it is recorded. */
interface VersionCountRow {
  version: string;
  n: number;
}

/** A row holding one `count(*)::int` result. */
interface CountRow {
  n: number;
}

/** A row holding one stored email. */
interface EmailRow {
  email: string;
}

/** A row holding an identity value. */
interface IdRow {
  id: number;
}

/** Sort properties of one index column, from `pg_index_column_has_property`. */
interface ColumnOrderRow {
  asc: boolean;
  nullsLast: boolean;
}

/** A trigger's name, table and definition. */
interface TriggerRow {
  tgname: string;
  tablename: string;
  definition: string;
}

/**
 * Raw `tasks` column values. Status and priority are plain strings so invalid labels can be
 * written, which the application's own types would refuse.
 */
interface TaskColumns {
  title: string;
  description: string;
  status: string;
  priority: string;
  completedAt: Date | null;
}

/** Raw `sessions` column values apart from the owning user. */
interface SessionColumns {
  id: Buffer;
  createdAt: Date;
  lastActiveAt: Date;
  expiresAt: Date;
}

/** A row that one CHECK constraint must reject. */
interface RejectedCase<F> {
  case: string;
  fields: Partial<F>;
  constraint: string;
}

/** A row that every CHECK constraint must accept. */
interface AcceptedCase<F> {
  case: string;
  fields: Partial<F>;
}

/** Returns every index name in the `public` schema. */
async function publicIndexNames(db: Pool): Promise<string[]> {
  const rows = await sql<Pick<IndexRow, 'indexname'>>(
    db,
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );
  return rows.map((row) => row.indexname);
}

/**
 * Returns the definition PostgreSQL reconstructs for one `public` index.
 *
 * @throws Error when no such index exists.
 */
async function indexDefinition(db: Pool, name: string): Promise<string> {
  const rows = await sql<IndexRow>(
    db,
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [name],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`index ${name} does not exist`);
  }
  return row.indexdef;
}

/** Inserts one task with every column bound: a valid `To do` row unless `fields` overrides it. */
async function insertTaskRow(
  db: Pool,
  ownerId: number,
  fields: Partial<TaskColumns>,
): Promise<number> {
  const row: TaskColumns = {
    title: 'Task',
    description: '',
    status: 'To do',
    priority: 'Medium',
    completedAt: null,
    ...fields,
  };
  const rows = await sql<IdRow>(
    db,
    'INSERT INTO tasks (owner_id, title, description, status, priority, due_date, created_at, ' +
      'updated_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8) RETURNING id',
    [ownerId, row.title, row.description, row.status, row.priority, at(), at(), row.completedAt],
  );
  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('insertTaskRow: no row returned');
  }
  return inserted.id;
}

/**
 * Inserts one session with every column bound: a valid row (random 32-byte id, created and last
 * active at the base instant, expiring 30 minutes later) unless `fields` overrides it.
 */
async function insertSessionRow(
  db: Pool,
  userId: number,
  fields: Partial<SessionColumns>,
): Promise<void> {
  const row: SessionColumns = {
    id: randomBytes(32),
    createdAt: at(),
    lastActiveAt: at(),
    expiresAt: at(30 * MINUTE_MS),
    ...fields,
  };
  await sql(
    db,
    'INSERT INTO sessions (id, user_id, created_at, last_active_at, expires_at) ' +
      'VALUES ($1, $2, $3, $4, $5)',
    [row.id, userId, row.createdAt, row.lastActiveAt, row.expiresAt],
  );
}

describe('database schema', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('migration versions', () => {
    it('applies nothing on an already migrated database and logs a count of 0', async () => {
      const logger = new CaptureLogger();

      await expect(runMigrations(pool, logger)).resolves.toEqual([]);

      expect(logger.byMsg(MIGRATIONS_APPLIED)).toEqual([
        expect.objectContaining({ level: 'info', count: 0, versions: '' }),
      ]);
    });

    it('records exactly the four versions, each named after its file without .sql', async () => {
      const rows = await sql<VersionRow>(
        pool,
        'SELECT version FROM schema_migrations ORDER BY version',
      );

      expect(rows.map((row) => row.version)).toEqual(ALL_VERSIONS);
    });
  });

  describe('indexes', () => {
    it('defines every index the schema plan names', async () => {
      expect(await publicIndexNames(pool)).toEqual(expect.arrayContaining([...PLANNED_INDEXES]));
    });

    // PostgreSQL reconstructs `indexdef` without the defaults it implies, so `ASC NULLS LAST`
    // never appears in it; the patterns tolerate those words and the schema qualifier.
    it.each<{ name: string; definition: RegExp }>([
      {
        name: 'users_email_lower_key',
        definition: /^CREATE UNIQUE INDEX \S+ ON (public\.)?users USING btree \(lower\(email\)\)$/,
      },
      {
        name: 'sessions_pkey',
        definition: /^CREATE UNIQUE INDEX sessions_pkey ON (public\.)?sessions USING btree \(id\)$/,
      },
      { name: 'sessions_user_id_idx', definition: /USING btree \(user_id\)$/ },
      { name: 'sessions_expires_at_idx', definition: /USING btree \(expires_at\)$/ },
      {
        name: 'tasks_owner_due_idx',
        definition: /USING btree \(owner_id, due_date( ASC)?( NULLS LAST)?, id\)$/,
      },
      {
        name: 'tasks_owner_completed_idx',
        definition: /USING btree \(owner_id, completed_at\) WHERE \(completed_at IS NOT NULL\)$/,
      },
      { name: 'tasks_owner_created_idx', definition: /USING btree \(owner_id, created_at, id\)$/ },
      {
        name: 'login_attempts_email_failed_idx',
        definition: /USING btree \(email, failed_at DESC\)$/,
      },
      { name: 'login_attempts_failed_at_idx', definition: /USING btree \(failed_at\)$/ },
    ])('defines $name on its planned columns', async ({ name, definition }) => {
      expect(await indexDefinition(pool, name)).toMatch(definition);
    });

    it('sorts tasks_owner_due_idx by due date ascending with undated tasks last', async () => {
      // The catalogue answers what `indexdef` leaves implicit for the second column, due_date.
      const rows = await sql<ColumnOrderRow>(
        pool,
        "SELECT pg_index_column_has_property('tasks_owner_due_idx'::regclass, 2, 'asc') AS asc, " +
          "pg_index_column_has_property('tasks_owner_due_idx'::regclass, 2, 'nulls_last') " +
          'AS "nullsLast"',
      );

      expect(rows).toEqual([{ asc: true, nullsLast: true }]);
    });
  });

  describe('tasks checks', () => {
    let ownerId: number;

    beforeEach(async () => {
      ownerId = await insertUser(pool, { email: 'task-checks@example.com', createdAt: at() });
    });

    it.each<RejectedCase<TaskColumns>>([
      { case: 'an empty title', fields: { title: '' }, constraint: 'tasks_title_check' },
      {
        case: 'a 201-character title',
        fields: { title: 'x'.repeat(201) },
        constraint: 'tasks_title_check',
      },
      {
        case: 'a title of 201 astral code points',
        fields: { title: ASTRAL_CHARACTER.repeat(201) },
        constraint: 'tasks_title_check',
      },
      {
        case: 'a 5,001-character description',
        fields: { description: 'd'.repeat(5001) },
        constraint: 'tasks_description_check',
      },
      {
        case: 'the status Blocked',
        fields: { status: 'Blocked' },
        constraint: 'tasks_status_check',
      },
      {
        case: 'the lower-case status to do',
        fields: { status: 'to do' },
        constraint: 'tasks_status_check',
      },
      {
        case: 'the priority Urgent',
        fields: { priority: 'Urgent' },
        constraint: 'tasks_priority_check',
      },
      {
        case: 'the lower-case priority high',
        fields: { priority: 'high' },
        constraint: 'tasks_priority_check',
      },
      {
        case: 'status Done without a completion time',
        fields: { status: 'Done', completedAt: null },
        constraint: 'tasks_completed_at_check',
      },
      {
        case: 'status To do with a completion time',
        fields: { status: 'To do', completedAt: at() },
        constraint: 'tasks_completed_at_check',
      },
      {
        case: 'status In progress with a completion time',
        fields: { status: 'In progress', completedAt: at() },
        constraint: 'tasks_completed_at_check',
      },
    ])('rejects $case', async ({ fields, constraint }) => {
      await expect(insertTaskRow(pool, ownerId, fields)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint,
      });
      expect(await countRows(pool, 'tasks')).toBe(0);
    });

    // 200 astral characters are 400 UTF-16 units and 800 UTF-8 bytes, so only a check that
    // counts code points, as `char_length` does, accepts them.
    it.each<AcceptedCase<TaskColumns>>([
      { case: 'a title of exactly 200 characters', fields: { title: 'x'.repeat(200) } },
      {
        case: 'a title of exactly 200 astral code points',
        fields: { title: ASTRAL_CHARACTER.repeat(200) },
      },
      {
        case: 'a description of exactly 5,000 characters',
        fields: { description: 'd'.repeat(5000) },
      },
      { case: 'status Done with a completion time', fields: { status: 'Done', completedAt: at() } },
    ])('accepts $case and stores it unchanged', async ({ fields }) => {
      const taskId = await insertTaskRow(pool, ownerId, fields);

      const stored = (await tasksForOwner(pool, ownerId)).find((task) => task.id === taskId);
      expect(stored).toMatchObject(fields);
    });
  });

  describe('sessions checks', () => {
    let userId: number;

    beforeEach(async () => {
      userId = await insertUser(pool, { email: 'session-checks@example.com', createdAt: at() });
    });

    it.each<RejectedCase<SessionColumns>>([
      { case: 'a 31-byte id', fields: { id: Buffer.alloc(31) }, constraint: 'sessions_id_check' },
      { case: 'a 33-byte id', fields: { id: Buffer.alloc(33) }, constraint: 'sessions_id_check' },
      {
        case: 'a last activity 1 ms before creation',
        fields: { lastActiveAt: at(-1) },
        constraint: 'sessions_last_active_at_check',
      },
      {
        case: 'an expiry 8 hours and 1 ms after creation',
        fields: { expiresAt: at(EIGHT_HOURS_MS + 1) },
        constraint: 'sessions_expires_at_check',
      },
    ])('rejects $case', async ({ fields, constraint }) => {
      await expect(insertSessionRow(pool, userId, fields)).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint,
      });
      expect(await countRows(pool, 'sessions')).toBe(0);
    });

    it('accepts a 32-byte id with an expiry exactly 8 hours after creation', async () => {
      const id = randomBytes(32);

      await insertSessionRow(pool, userId, { id, expiresAt: at(EIGHT_HOURS_MS) });

      expect(await sessionsForUser(pool, userId)).toEqual([
        { idHash: id, userId, createdAt: at(), lastActiveAt: at(), expiresAt: at(EIGHT_HOURS_MS) },
      ]);
    });
  });

  describe('users checks', () => {
    it.each<{ case: string; email: string }>([
      { case: 'a 2-character email', email: 'a@' },
      { case: 'a 255-character email', email: emailOfLength(255) },
    ])('rejects $case', async ({ email }) => {
      await expect(insertUser(pool, { email, createdAt: at() })).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'users_email_check',
      });
      expect(await countRows(pool, 'users')).toBe(0);
    });

    it.each<{ case: string; email: string }>([
      { case: 'a 3-character email', email: 'a@b' },
      { case: 'a 254-character email', email: emailOfLength(254) },
    ])('accepts $case', async ({ email }) => {
      await insertUser(pool, { email, createdAt: at() });

      expect(await sql<EmailRow>(pool, 'SELECT email FROM users')).toEqual([{ email }]);
    });
  });

  describe('case-insensitive email uniqueness', () => {
    it.each(['user@x.com', 'USER@X.COM', 'uSeR@x.CoM'])(
      'rejects %s once User@x.com exists and keeps the stored case',
      async (duplicate) => {
        await insertUser(pool, { email: 'User@x.com', createdAt: at() });

        const second = insertUser(pool, { email: duplicate, createdAt: at() });

        await expect(second).rejects.toMatchObject({
          code: UNIQUE_VIOLATION,
          constraint: 'users_email_lower_key',
        });
        expect(await sql<EmailRow>(pool, 'SELECT email FROM users')).toEqual([
          { email: 'User@x.com' },
        ]);
      },
    );
  });


  describe('user deletion', () => {
    it('defines users_delete_login_attempts as an AFTER DELETE row trigger on users', async () => {
      const rows = await sql<TriggerRow>(
        pool,
        'SELECT tgname, tgrelid::regclass::text AS tablename, ' +
          'pg_get_triggerdef(oid) AS definition ' +
          "FROM pg_trigger WHERE tgname = 'users_delete_login_attempts'",
      );

      expect(rows).toEqual([
        {
          tgname: 'users_delete_login_attempts',
          tablename: 'users',
          definition: expect.stringMatching(
            new RegExp(
              'AFTER DELETE ON (public\\.)?users FOR EACH ROW ' +
                'EXECUTE FUNCTION (public\\.)?delete_login_attempts_for_user\\(\\)$',
            ),
          ),
        },
      ]);
    });

    it("removes the user's sessions, tasks and login attempts and nobody else's", async () => {
      const aliceId = await insertUser(pool, { email: 'Alice@Example.com', createdAt: at() });
      const bobId = await insertUser(pool, { email: 'bob@example.com', createdAt: at() });
      await insertSessionRow(pool, aliceId, {});
      await insertSessionRow(pool, bobId, {});
      await insertTask(pool, aliceId, { title: 'Alice open' });
      await insertTask(pool, aliceId, { title: 'Alice done', status: 'Done' });
      await insertTask(pool, bobId, { title: 'Bob open' });
      // The lockout key is the normalised email, which the trigger rebuilds from the stored
      // 'Alice@Example.com' with lower(btrim(...)).
      await insertLoginFailures(pool, 'alice@example.com', [at(MINUTE_MS), at(2 * MINUTE_MS)]);
      await insertLoginFailures(pool, 'bob@example.com', [at(3 * MINUTE_MS)]);
      await insertLoginFailures(pool, 'ghost@example.com', [at(4 * MINUTE_MS), at(5 * MINUTE_MS)]);
      expect(await sessionsForUser(pool, aliceId)).toHaveLength(1);
      expect(await tasksForOwner(pool, aliceId)).toHaveLength(2);
      expect(await loginAttemptRows(pool, 'alice@example.com')).toHaveLength(2);

      await sql(pool, 'DELETE FROM users WHERE id = $1', [aliceId]);

      expect(await sessionsForUser(pool, aliceId)).toEqual([]);
      expect(await tasksForOwner(pool, aliceId)).toEqual([]);
      expect(await loginAttemptRows(pool, 'alice@example.com')).toEqual([]);

      expect(await sql<EmailRow>(pool, 'SELECT email FROM users')).toEqual([
        { email: 'bob@example.com' },
      ]);
      expect(await sessionsForUser(pool, bobId)).toHaveLength(1);
      expect((await tasksForOwner(pool, bobId)).map((task) => task.title)).toEqual(['Bob open']);
      expect(await loginAttemptRows(pool, 'bob@example.com')).toHaveLength(1);
      expect(await loginAttemptRows(pool, 'ghost@example.com')).toHaveLength(2);
    });
  });

  // Keep this describe last: it drops the whole schema and must leave it fully migrated for the
  // suites that run after this file.
  describe('simultaneous fresh start', () => {
    const extraPools: Pool[] = [];

    afterAll(async () => {
      for (const extra of extraPools) {
        if (!extra.ended) {
          await extra.end();
        }
      }
      // Restores the schema should a test below have failed between the drop and the rebuild;
      // on a migrated database it applies nothing.
      await runMigrations(pool, new CaptureLogger());
    });

    it('applies each migration once when two pools migrate an empty schema at once', async () => {
      await sql(pool, 'DROP SCHEMA public CASCADE');
      await sql(pool, 'CREATE SCHEMA public');
      expect(await publicIndexNames(pool)).toEqual([]);

      const logger1 = new CaptureLogger();
      const logger2 = new CaptureLogger();
      const p1 = createPool(testDatabaseUrl(), logger1);
      const p2 = createPool(testDatabaseUrl(), logger2);
      extraPools.push(p1, p2);

      const [a, b] = await Promise.all([runMigrations(p1, logger1), runMigrations(p2, logger2)]);

      // Which runner wins the lock is a race, so only the union and disjointness are asserted.
      expect([...a, ...b].sort()).toEqual(ALL_VERSIONS);
      expect(a.filter((version) => b.includes(version))).toEqual([]);
      expect(
        await sql<VersionCountRow>(
          pool,
          'SELECT version, count(*)::int AS n FROM schema_migrations GROUP BY version ' +
            'ORDER BY version',
        ),
      ).toEqual(ALL_VERSIONS.map((version) => ({ version, n: 1 })));
      expect(await countRows(pool, 'schema_migrations')).toBe(ALL_VERSIONS.length);

      const applied = [...logger1.byMsg(MIGRATIONS_APPLIED), ...logger2.byMsg(MIGRATIONS_APPLIED)];
      expect(applied).toHaveLength(2);
      expect(applied.reduce((sum, entry) => sum + Number(entry.count), 0)).toBe(
        ALL_VERSIONS.length,
      );
      expect(logger1.byMsg(MIGRATION_UNLOCK_FAILED)).toEqual([]);
      expect(logger2.byMsg(MIGRATION_UNLOCK_FAILED)).toEqual([]);

      // Checked while both pools still hold their connections, so a lock left behind could not
      // have been freed by a session ending. pg_locks spans the cluster, hence the database filter.
      expect(
        await sql<CountRow>(
          pool,
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = " +
            '(SELECT oid FROM pg_database WHERE datname = current_database())',
        ),
      ).toEqual([{ n: 0 }]);

      await p1.end();
      await p2.end();
    });

    it('leaves a fully indexed, usable schema behind', async () => {
      expect(await publicIndexNames(pool)).toEqual(expect.arrayContaining([...PLANNED_INDEXES]));

      const userId = await insertUser(pool, {
        email: 'after-rebuild@example.com',
        createdAt: at(),
      });
      await insertTask(pool, userId, { title: 'After rebuild' });

      expect(await countRows(pool, 'users')).toBe(1);
      expect(await tasksForOwner(pool, userId)).toHaveLength(1);
      await expect(runMigrations(pool, new CaptureLogger())).resolves.toEqual([]);
    });
  });
});


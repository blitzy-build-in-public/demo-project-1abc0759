import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { runMigrations } from '../../src/db/migrate';
import { DatabaseUnavailableError } from '../../src/shared/errors';
import type { Logger, LogFields } from '../../src/shared/logger';

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
 * with no rows, except that it rejects the migration file's SQL with `migrationError` and the
 * unlock with `unlockError` when `fail` says so, and behaves as a dead client once
 * `fail.connectionLost` has been emitted.
 */
function createFakeDatabase(
  fail: FailurePlan,
  migrationError: Error,
  unlockError: Error,
): FakeDatabase {
  const statements: string[] = [];
  const releaseCalls: unknown[][] = [];
  const events = new EventEmitter();
  let lost = false;
  const client = Object.assign(events, {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      statements.push(sql);
      const connectionError = fail.connectionLost;
      if (connectionError !== undefined && sql === MIGRATION_SQL) {
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
      if (fail.migration && sql === MIGRATION_SQL) {
        throw migrationError;
      }
      if (fail.unlock && sql === UNLOCK_SQL) {
        throw unlockError;
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

describe('runMigrations client release', () => {
  let dir: string;
  let migrationError: Error;
  let unlockError: Error;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'migrate-unit-'));
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

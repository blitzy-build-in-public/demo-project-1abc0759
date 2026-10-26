import type { Pool } from 'pg';

import { runMigrations } from '../../src/db/migrate';
import { main } from '../../src/db/migrate-cli';
import type { Logger } from '../../src/shared/logger';

jest.mock('../../src/db/migrate', () => ({ runMigrations: jest.fn() }));

const mockedRunMigrations = jest.mocked(runMigrations);

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

describe('migrate CLI main', () => {
  const originalEnv = process.env;
  let chunks: string[];
  let stdoutWrite: jest.SpiedFunction<typeof process.stdout.write>;

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
    mockedRunMigrations.mockReset();
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

      await main();

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

    await main();

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

      await main();

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

    await main();

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

    await main();

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
});

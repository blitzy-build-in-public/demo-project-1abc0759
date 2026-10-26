/**
 * Test database access: the `_test` name guard, the per-test reset, direct-insert fixtures and the
 * "database truth" readers that integration and end-to-end tests compare pages and exports with.
 *
 * The module is runner-neutral, so Jest suites, both global setups and the Playwright support
 * files can import it alike. Pools come from the application's own `createPool`, so the readers
 * see values exactly as the application does: DATE as `YYYY-MM-DD` text, INT8 as `number`,
 * TIMESTAMPTZ as `Date`, and every session in UTC.
 *
 * Every timestamp a fixture writes is a bound parameter supplied by the caller or a fixed default,
 * never the database's `now()`, matching the application, which takes all times from its `Clock`.
 */

import type { Pool } from 'pg';

import { createPool } from '../../src/db/pool';
import { query } from '../../src/db/query';
import type { Queryable } from '../../src/db/query';
import type { NewSessionRow, TaskRecord, UserId } from '../../src/db/types';
import type { IsoDate } from '../../src/shared/dates';
import type { TaskPriority, TaskStatus } from '../../src/shared/task-values';

import { CaptureLogger } from './capture-logger';

/** Suffix every database name must carry before a test may connect to it. */
const TEST_DATABASE_SUFFIX = '_test';

/** URL schemes whose database `pg` takes from the path, the only part the name check reads. */
const POSTGRES_PROTOCOLS: readonly string[] = ['postgres:', 'postgresql:'];

/**
 * Returns `url` once it is a `postgres://` or `postgresql://` URL naming a database whose name
 * ends in `_test`, and throws otherwise.
 *
 * This is the guard that keeps resets and fixtures away from development and production data.
 * Only the scheme and the name are checked: an unreachable URL such as
 * `postgres://tasktracker:x@127.0.0.1:1/unreachable_test` passes, which the database-unavailable
 * tests rely on. No message includes the user name, the password or the URL itself.
 *
 * @param url - A PostgreSQL connection string, usually `process.env.DATABASE_URL`.
 * @returns `url`, unchanged.
 * @throws Error when `url` is missing or empty, cannot be parsed as a URL, is not a
 *   `postgres://` or `postgresql://` URL, or names a database whose name does not end in `_test`.
 */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set; point it at a database whose name ends in _test');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The parser's own error quotes the input, which may carry the password.
    throw new Error('DATABASE_URL is not a valid URL');
  }
  // `pg` reads a `socket:` URL's database from its `db` query parameter rather than the path, so
  // only schemes whose database is the path can be name-checked.
  if (!POSTGRES_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must be a postgres:// connection string');
  }
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to use database "${name}": its name must end in _test`);
  }
  return url;
}

/**
 * Returns `process.env.DATABASE_URL` after {@link assertTestDatabaseUrl} has accepted it.
 *
 * @returns The test database connection string.
 * @throws Error when the variable is unset or does not name a `_test` database.
 */
export function testDatabaseUrl(): string {
  return assertTestDatabaseUrl(process.env.DATABASE_URL);
}

/**
 * Creates a pool on a test database through the application's `createPool`, so the type parsers,
 * the UTC session time zone and the pool limits are the production ones.
 *
 * The `_test` guard is applied to `url` even when it is passed explicitly. The caller owns the
 * pool and must call `pool.end()` when done.
 *
 * @param url - Connection string; defaults to {@link testDatabaseUrl}.
 * @param logger - Receives idle-client errors; defaults to a fresh {@link CaptureLogger}, so a
 *   test pool never writes to standard output.
 * @returns A new pool. No connection is opened until the first query.
 * @throws Error when `url` fails the `_test` guard.
 */
export function createTestPool(
  url: string = testDatabaseUrl(),
  logger: CaptureLogger = new CaptureLogger(),
): Pool {
  return createPool(assertTestDatabaseUrl(url), logger);
}

/**
 * Empties every application table and restarts their identity sequences at 1.
 *
 * `schema_migrations` is left intact, so the migrated schema survives the reset. `TRUNCATE` fires
 * no row triggers, which is why `login_attempts` is listed explicitly instead of relying on the
 * user-delete trigger. Integration suites call this in `beforeEach`; the end-to-end global setup
 * calls it once before the run.
 *
 * @param db - A pool on a database already accepted by the `_test` guard.
 */
export async function truncateAll(db: Pool): Promise<void> {
  await query(db, 'TRUNCATE users, sessions, tasks, login_attempts RESTART IDENTITY CASCADE', []);
}

/**
 * Runs parameterised SQL and returns its rows, typed as `R`.
 *
 * A thin wrapper over the application's query helper, so a connection failure surfaces as
 * `DatabaseUnavailableError` exactly as it does in the application.
 *
 * @typeParam R - Row shape the SQL selects, under its column names or aliases.
 * @param db - A pool or a checked-out client.
 * @param text - SQL with `$1`, `$2`, … placeholders; values are never interpolated into it.
 * @param params - Values bound to the placeholders in order.
 * @returns The rows returned.
 */
export async function sql<R>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return query<R>(db, text, params);
}

/**
 * A syntactically valid bcrypt cost-12 hash that no known password matches: the `$2b$12$` prefix
 * followed by 53 characters of the bcrypt alphabet.
 *
 * Use it for users who never log in. A test that logs in must store a real `bcrypt.hash` of its
 * password instead, or sign up through the application.
 */
export const FIXTURE_PASSWORD_HASH = `$2b$12$${'N'.repeat(53)}`;

/**
 * Default instant for fixture timestamps: `2026-10-21T09:00:00.000Z`, the same instant a new
 * `FakeClock` starts at, so fixtures and application writes line up by default.
 */
export const FIXTURE_TIME = new Date('2026-10-21T09:00:00.000Z');

/** A row holding only an identity value. */
interface IdRow {
  id: number;
}

/** A row holding only a `count(*)` result. */
interface CountRow {
  count: number;
}

/**
 * Inserts a user directly, bypassing sign-up and its bcrypt cost.
 *
 * The email is stored exactly as given, with no trimming or case change, so the case-insensitive
 * uniqueness index can be exercised directly.
 *
 * @param db - A pool or a checked-out client.
 * @param input - The email, an optional password hash (default {@link FIXTURE_PASSWORD_HASH})
 *   and the creation instant.
 * @returns The new user's id.
 * @throws The driver error for a check or unique violation, such as `23505` on
 *   `users_email_lower_key`.
 */
export async function insertUser(
  db: Queryable,
  input: { email: string; passwordHash?: string; createdAt: Date },
): Promise<UserId> {
  const rows = await query<IdRow>(
    db,
    'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
    [input.email, input.passwordHash ?? FIXTURE_PASSWORD_HASH, input.createdAt],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertUser: no row returned');
  }
  return row.id;
}

/**
 * Field values for {@link insertTask}. Every field is optional; an absent field takes the
 * documented default, and a present one, `null` included, is written exactly as given.
 */
export interface TaskFixture {
  /** Default `'Task'`. */
  title?: string;
  /** Default `''`. */
  description?: string;
  /** Default `'To do'`. */
  status?: TaskStatus;
  /** Default `'Medium'`. */
  priority?: TaskPriority;
  /** Default `null` (no due date). */
  dueDate?: IsoDate | null;
  /** Default {@link FIXTURE_TIME}. */
  createdAt?: Date;
  /** Default: the later of `createdAt` and `completedAt`. */
  updatedAt?: Date;
  /** Default: `createdAt` when the status is `Done`, otherwise `null`. */
  completedAt?: Date | null;
}

/**
 * Select list mapping `tasks` columns to {@link TaskRecord} fields, shared by the insert and the
 * readers so both return identical records.
 */
const TASK_COLUMNS =
  'id, owner_id AS "ownerId", title, description, status, priority, ' +
  'due_date AS "dueDate", created_at AS "createdAt", updated_at AS "updatedAt", ' +
  'completed_at AS "completedAt"';

/** The later of two instants, or `a` when `b` is `null`. */
function laterOf(a: Date, b: Date | null): Date {
  return b !== null && b.getTime() > a.getTime() ? b : a;
}

/**
 * Inserts a task for `ownerId` directly, bypassing the task service and its rules.
 *
 * Defaults: title `'Task'`, description `''`, status `'To do'`, priority `'Medium'`, no due date,
 * `createdAt` {@link FIXTURE_TIME}, `completedAt` equal to `createdAt` for a `Done` task and
 * `null` otherwise, and `updatedAt` the later of `createdAt` and `completedAt`. The defaults
 * always satisfy the table's checks.
 *
 * Explicit values are written verbatim, `completedAt: null` on a `Done` task included, so schema
 * tests can provoke check violations through this helper.
 *
 * @param db - A pool or a checked-out client.
 * @param ownerId - The owning user's id.
 * @param partial - Field values overriding the defaults.
 * @returns The stored task, read back through the same select list as {@link tasksForOwner}.
 * @throws The driver error for a check or foreign-key violation.
 */
export async function insertTask(
  db: Queryable,
  ownerId: UserId,
  partial: TaskFixture = {},
): Promise<TaskRecord> {
  const status: TaskStatus = partial.status ?? 'To do';
  const createdAt = partial.createdAt ?? FIXTURE_TIME;
  // `undefined` means "use the default"; an explicit `null` is kept, even for a `Done` task.
  const completedAt =
    partial.completedAt !== undefined
      ? partial.completedAt
      : status === 'Done'
        ? createdAt
        : null;
  const updatedAt = partial.updatedAt ?? laterOf(createdAt, completedAt);
  const rows = await query<TaskRecord>(
    db,
    'INSERT INTO tasks (owner_id, title, description, status, priority, due_date, created_at, ' +
      'updated_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9) ' +
      `RETURNING ${TASK_COLUMNS}`,
    [
      ownerId,
      partial.title ?? 'Task',
      partial.description ?? '',
      status,
      partial.priority ?? 'Medium',
      partial.dueDate ?? null,
      createdAt,
      updatedAt,
      completedAt,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('insertTask: no row returned');
  }
  return row;
}

/**
 * Records one failed login for `normalizedEmail` at each of `dates`, as the lockout rule would
 * have stored them. Does nothing for an empty array.
 *
 * @param db - A pool or a checked-out client.
 * @param normalizedEmail - The lockout key, written as given; pass the trimmed, lower-cased form
 *   that `normalizeEmail` produces.
 * @param dates - One failure instant per row.
 */
export async function insertLoginFailures(
  db: Queryable,
  normalizedEmail: string,
  dates: readonly Date[],
): Promise<void> {
  if (dates.length === 0) {
    return;
  }
  await query(
    db,
    'INSERT INTO login_attempts (email, failed_at) SELECT $1::text, unnest($2::timestamptz[])',
    [normalizedEmail, [...dates]],
  );
}

/**
 * Looks up a user's id by email, ignoring case, as the login lookup does.
 *
 * @param db - A pool or a checked-out client.
 * @param email - The email to look up.
 * @returns The id, or `null` when no user has that email.
 */
export async function userIdByEmail(db: Queryable, email: string): Promise<UserId | null> {
  const rows = await query<IdRow>(db, 'SELECT id FROM users WHERE lower(email) = lower($1)', [
    email,
  ]);
  return rows[0]?.id ?? null;
}

/**
 * Row order for {@link tasksForOwner}: `'created'` is the CSV export order and `'due'` the task
 * list order.
 */
export type TaskOrder = 'created' | 'due';

/** The only `ORDER BY` clauses {@link tasksForOwner} interpolates; caller text never does. */
const TASK_ORDER_BY: Readonly<Record<TaskOrder, string>> = {
  created: 'created_at, id',
  due: 'due_date ASC NULLS LAST, id ASC',
};

/**
 * Reads every task of one owner straight from the table: the truth pages and exports are
 * compared with.
 *
 * @param db - A pool or a checked-out client.
 * @param ownerId - The owner whose tasks are read.
 * @param order - `'created'` (default) orders by `created_at, id`, the export order; `'due'`
 *   orders by `due_date ASC NULLS LAST, id ASC`, the list order.
 * @returns The owner's tasks, empty when there are none.
 */
export async function tasksForOwner(
  db: Queryable,
  ownerId: UserId,
  order: TaskOrder = 'created',
): Promise<TaskRecord[]> {
  return query<TaskRecord>(
    db,
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE owner_id = $1 ORDER BY ${TASK_ORDER_BY[order]}`,
    [ownerId],
  );
}

/**
 * Reads every session row of one user, ordered by `created_at, id`.
 *
 * @param db - A pool or a checked-out client.
 * @param userId - The user whose sessions are read.
 * @returns The rows; `idHash` is the stored 32-byte SHA-256 of the token, as a `Buffer`.
 */
export async function sessionsForUser(db: Queryable, userId: UserId): Promise<NewSessionRow[]> {
  return query<NewSessionRow>(
    db,
    'SELECT id AS "idHash", user_id AS "userId", created_at AS "createdAt", ' +
      'last_active_at AS "lastActiveAt", expires_at AS "expiresAt" ' +
      'FROM sessions WHERE user_id = $1 ORDER BY created_at, id',
    [userId],
  );
}

/** One stored failed login, as {@link loginAttemptRows} returns it. */
export interface LoginAttemptRow {
  /** Identity value of the row. */
  id: number;
  /** The normalised lockout key. */
  email: string;
  /** Instant of the failure. */
  failedAt: Date;
}

/**
 * Reads every recorded failure for one lockout key, newest first, the order the lockout check
 * reads them in.
 *
 * @param db - A pool or a checked-out client.
 * @param normalizedEmail - The exact key stored in `login_attempts.email`.
 * @returns The rows ordered by `failed_at DESC, id DESC`.
 */
export async function loginAttemptRows(
  db: Queryable,
  normalizedEmail: string,
): Promise<LoginAttemptRow[]> {
  return query<LoginAttemptRow>(
    db,
    'SELECT id, email, failed_at AS "failedAt" FROM login_attempts WHERE email = $1 ' +
      'ORDER BY failed_at DESC, id DESC',
    [normalizedEmail],
  );
}

/** A table {@link countRows} may count. */
export type CountableTable =
  | 'users'
  | 'sessions'
  | 'tasks'
  | 'login_attempts'
  | 'schema_migrations';

/** Run-time allow-list for {@link countRows}, the only table names it interpolates into SQL. */
const COUNTABLE_TABLES: readonly CountableTable[] = [
  'users',
  'sessions',
  'tasks',
  'login_attempts',
  'schema_migrations',
];

/**
 * Counts the rows of one table.
 *
 * @param db - A pool or a checked-out client.
 * @param table - One of the allow-listed tables; checked again at run time before it is
 *   interpolated, because a table name cannot be a bound parameter.
 * @returns The number of rows.
 * @throws Error `countRows: table not allowed` for any other name.
 */
export async function countRows(db: Queryable, table: CountableTable): Promise<number> {
  if (!COUNTABLE_TABLES.includes(table)) {
    throw new Error('countRows: table not allowed');
  }
  const rows = await query<CountRow>(db, `SELECT count(*) AS count FROM ${table}`, []);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('countRows: no row returned');
  }
  return Number(row.count);
}

/**
 * Integration tests for the migrated schema against real PostgreSQL 16 (plan 0.5.2, 0.9.2).
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
 * The final describe drops the `public` schema and rebuilds it from two pools at once, the way
 * replicas start together. It must stay last in this file, and it leaves the schema fully
 * migrated for the suites that follow in the same run.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { runMigrations } from '../../src/db/migrate';
import { createPool } from '../../src/db/pool';

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


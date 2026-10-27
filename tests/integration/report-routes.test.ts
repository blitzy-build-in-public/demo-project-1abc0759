/**
 * Integration tests for `GET /reports` and `GET /reports/export` against real PostgreSQL 16
 * (plan 0.8.1, 0.9.1 SC7–SC11, 0.5.3 and 0.5.4).
 *
 * Every page and file is compared with "database truth": counts and rows read straight from the
 * `tasks` table with independent SQL, never through the report module. Expected literal values
 * are asserted beside the SQL, so the query and the page cannot both be wrong in the same way.
 *
 * The application runs in process on the real stack with a `FakeClock` at
 * `2026-10-21T09:00:00.000Z`, so "today" is `2026-10-21` and the default completions range is
 * `2026-09-22` to `2026-10-21`. Seed tasks are inserted directly with explicit timestamps; only the
 * year-9999 case creates its task through `POST /tasks/new`, so the creation time comes from the
 * application's own clock. Every sign-up and login performs a real cost-12 bcrypt operation.
 *
 * The file also checks the timestamp defaults of `insertTask`, the fixture every seed here goes
 * through, against a fake `Queryable` that records the values it binds, so those cases run no
 * sign-up, open no connection and need no database.
 */

import type { Pool } from 'pg';

import type { Queryable } from '../../src/db/query';

import { parseCsv } from '../helpers/csv-parse';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import type { HttpClient, HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import {
  FIXTURE_TIME,
  createTestPool,
  insertTask,
  sql,
  tasksForOwner,
  truncateAll,
} from '../helpers/test-db';
import type { TaskFixture } from '../helpers/test-db';

/** A task row as the database-truth reader returns it. */
type StoredTask = Awaited<ReturnType<typeof tasksForOwner>>[number];

/** Password of every account these tests create; it meets the sign-up policy. */
const PASSWORD = 'ReportsPassw0rd';

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000;

/** Creation time of seed tasks whose creation instant the test does not depend on. */
const SEED_CREATED_AT = '2026-08-01T09:00:00.000Z';

const NO_COMPLETIONS = 'No tasks were completed in this period.';
const START_AFTER_END = 'Start date must be on or before end date.';
const RANGE_TOO_LONG = 'Date range cannot be longer than 366 days.';
const INVALID_DATES = 'Enter valid start and end dates.';
const INVALID_STATUS = 'Choose a valid status.';
const BAD_REQUEST = 'Bad request.';

/** The export's header record, column by column. */
const CSV_HEADER_RECORD: readonly string[] = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'due date',
  'created time',
  'completed time',
];

/** The complete body of an export that matches no task: byte-order mark, header, one CRLF. */
const HEADER_ONLY_EXPORT =
  '\uFEFF' + 'id,title,description,status,priority,due date,created time,completed time' + '\r\n';

/** The summary's `data-testid` values, in page order. */
type SummaryId =
  | 'open-todo'
  | 'open-in-progress'
  | 'open-low'
  | 'open-medium'
  | 'open-high'
  | 'overdue';

/** The six summary counts, keyed by their `data-testid`. */
type SummaryCounts = Record<SummaryId, number>;

const ZERO_SUMMARY: SummaryCounts = {
  'open-todo': 0,
  'open-in-progress': 0,
  'open-low': 0,
  'open-medium': 0,
  'open-high': 0,
  overdue: 0,
};

/** One row of the completions table. */
interface DayRow {
  day: string;
  count: number;
}

/** A signed-in test user. */
interface Account {
  email: string;
  userId: number;
  /** A client holding the user's session cookie. */
  client: HttpClient;
}

/** A row holding only an identity value. */
interface IdRow {
  id: number;
}

/** A row of {@link SUMMARY_TRUTH_SQL}. INT8 counts arrive as numbers. */
interface SummaryTruthRow {
  todo: number;
  inprog: number;
  low: number;
  medium: number;
  high: number;
  overdue: number;
}

/** A row of {@link COMPLETIONS_TRUTH_SQL}. */
interface CompletionTruthRow {
  day: string;
  n: number;
}

/** Open-task counts straight from the table; `$2` is today's UTC date. */
const SUMMARY_TRUTH_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'To do')       AS todo,
    count(*) FILTER (WHERE status = 'In progress') AS inprog,
    count(*) FILTER (WHERE priority = 'Low')       AS low,
    count(*) FILTER (WHERE priority = 'Medium')    AS medium,
    count(*) FILTER (WHERE priority = 'High')      AS high,
    count(*) FILTER (WHERE due_date < $2::date)    AS overdue
  FROM tasks
  WHERE owner_id = $1 AND status <> 'Done'`;

/** Completions per UTC day straight from the table, over every day that has any. */
const COMPLETIONS_TRUTH_SQL = `
  SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n
    FROM tasks
   WHERE owner_id = $1 AND completed_at IS NOT NULL
   GROUP BY 1`;

/**
 * A completions-table row: a `<tr>` carrying both `data-day` and `data-count`, in either order.
 * The lookaheads read each attribute independently of its position in the tag.
 */
const COMPLETION_ROW = /<tr\b(?=[^>]*\sdata-day="([^"]*)")(?=[^>]*\sdata-count="(\d+)")[^>]*>/g;

/** The opening tag of the chart figure, whatever its attribute order. */
const CHART_FIGURE_TAG = /<figure\b[^>]*\sid="completions-chart"[^>]*>/;

/** Returns the instant an ISO 8601 timestamp names. */
function at(iso: string): Date {
  return new Date(iso);
}

/** Reads one summary count, the bare number inside the element carrying `data-testid="<id>"`. */
function summaryCount(body: string, id: SummaryId): number {
  const digits = new RegExp(`data-testid="${id}"[^>]*>(\\d+)<`).exec(body)?.[1];
  if (digits === undefined) {
    throw new Error(`summary count "${id}" not found on the page`);
  }
  return Number(digits);
}

/** Reads all six summary counts from a reports page. */
function summaryCounts(body: string): SummaryCounts {
  return {
    'open-todo': summaryCount(body, 'open-todo'),
    'open-in-progress': summaryCount(body, 'open-in-progress'),
    'open-low': summaryCount(body, 'open-low'),
    'open-medium': summaryCount(body, 'open-medium'),
    'open-high': summaryCount(body, 'open-high'),
    overdue: summaryCount(body, 'overdue'),
  };
}

/** Reads every completions-table row in document order. */
function completionRows(body: string): DayRow[] {
  const rows: DayRow[] = [];
  for (const match of body.matchAll(COMPLETION_ROW)) {
    const day = match[1];
    const count = match[2];
    if (day === undefined || count === undefined) {
      throw new Error('completion row without data-day or data-count');
    }
    rows.push({ day, count: Number(count) });
  }
  return rows;
}

/**
 * Lists every UTC day from `from` to `to`, both included, built by index so the day after `to`
 * is never computed. `Date.parse` of a four-digit ISO year is exact for years 0001 to 9999.
 */
function expectedDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  const length = (end - start) / DAY_MS + 1;
  return Array.from({ length }, (_value, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * Builds the expected export records independently of the application's CSV writer: the
 * owner's stored tasks (already in `created_at, id` order) created on a UTC day from `from` to
 * `to`, optionally with exactly `status`, as their eight unescaped fields.
 */
function expectedCsvRecords(
  stored: readonly StoredTask[],
  from: string,
  to: string,
  status: string | null,
): string[][] {
  const lower = Date.parse(`${from}T00:00:00.000Z`);
  const upper = Date.parse(`${to}T00:00:00.000Z`) + DAY_MS;
  return stored
    .filter((task) => {
      const created = task.createdAt.getTime();
      return created >= lower && created < upper && (status === null || task.status === status);
    })
    .map((task) => [
      String(task.id),
      task.title,
      task.description,
      task.status,
      task.priority,
      task.dueDate ?? '',
      task.createdAt.toISOString(),
      task.completedAt ? task.completedAt.toISOString() : '',
    ]);
}

/** An open task created at {@link SEED_CREATED_AT}, with no completion time. */
function openTask(
  title: string,
  status: 'To do' | 'In progress',
  priority: 'Low' | 'Medium' | 'High',
  dueDate: string | null,
): TaskFixture {
  return { title, status, priority, dueDate, createdAt: at(SEED_CREATED_AT), completedAt: null };
}

/** A `Done` task created at {@link SEED_CREATED_AT} and completed at `completedAt`. */
function doneTask(
  title: string,
  priority: 'Low' | 'Medium' | 'High',
  dueDate: string | null,
  completedAt: string,
): TaskFixture {
  return {
    title,
    status: 'Done',
    priority,
    dueDate,
    createdAt: at(SEED_CREATED_AT),
    completedAt: at(completedAt),
  };
}

describe('report routes', () => {
  let app: TestApp;
  let pool: Pool;
  let clock: FakeClock;
  /** User A, signed up and logged in before every test. */
  let a: Account;

  beforeAll(async () => {
    clock = new FakeClock();
    app = await startTestApp({ clock });
    pool = createTestPool();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    clock.set(FAKE_CLOCK_START);
    a = await signUpAndLogIn('owner-a@example.com');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  /** Logs `email` in on `client` through the login form, landing on `/tasks`. */
  async function logIn(client: HttpClient, email: string): Promise<void> {
    expect((await client.get('/login')).status).toBe(200);
    const res = await client.post('/login', { email, password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks');
  }

  /** Signs a new user up through the form, logs them in on a fresh client and returns them. */
  async function signUpAndLogIn(email: string): Promise<Account> {
    const client = app.client();
    expect((await client.get('/signup')).status).toBe(200);
    const created = await client.post('/signup', { email, password: PASSWORD });
    expect(created.status).toBe(303);
    expect(created.location).toBe('/login?created=1');
    await logIn(client, email);
    const rows = await sql<IdRow>(pool, 'SELECT id FROM users WHERE lower(email) = lower($1)', [
      email,
    ]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`no user row for ${email}`);
    }
    return { email, userId: row.id, client };
  }

  /** Inserts the fixtures for `ownerId` one by one, so ids follow the array order. */
  async function seed(ownerId: number, fixtures: readonly TaskFixture[]): Promise<void> {
    for (const fixture of fixtures) {
      await insertTask(pool, ownerId, fixture);
    }
  }

  /** Fetches a reports page, asserting its status and that it is HTML, and returns the body. */
  async function getPage(client: HttpClient, path: string, status: number): Promise<string> {
    const res = await client.get(path);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    return res.body;
  }

  /** Requests an export and asserts it answered with the CSV file named for the range. */
  async function getExport(
    client: HttpClient,
    from: string,
    to: string,
    status: string,
  ): Promise<HttpResult> {
    const query = new URLSearchParams({ from, to, status }).toString();
    const res = await client.get(`/reports/export?${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="tasks-${from}-to-${to}.csv"`,
    );
    return res;
  }

  /** The owner's summary counts computed by direct SQL with the clock's date as today. */
  async function summaryTruth(ownerId: number): Promise<SummaryCounts> {
    const today = clock.now().toISOString().slice(0, 10);
    const rows = await sql<SummaryTruthRow>(pool, SUMMARY_TRUTH_SQL, [ownerId, today]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('summary truth query returned no row');
    }
    return {
      'open-todo': row.todo,
      'open-in-progress': row.inprog,
      'open-low': row.low,
      'open-medium': row.medium,
      'open-high': row.high,
      overdue: row.overdue,
    };
  }

  /** The owner's completions for every day of the range by direct SQL, 0 where none. */
  async function completionsTruth(ownerId: number, from: string, to: string): Promise<DayRow[]> {
    const rows = await sql<CompletionTruthRow>(pool, COMPLETIONS_TRUTH_SQL, [ownerId]);
    const byDay = new Map(rows.map((row): [string, number] => [row.day, row.n]));
    return expectedDays(from, to).map((day) => ({ day, count: byDay.get(day) ?? 0 }));
  }

  describe('summary (SC8, FR-11)', () => {
    /** Open tasks across both open statuses and all priorities, plus two `Done` tasks. */
    const SUMMARY_MIX: readonly TaskFixture[] = [
      openTask('To do, Low, due yesterday', 'To do', 'Low', '2026-10-20'),
      openTask('To do, Medium, due today', 'To do', 'Medium', '2026-10-21'),
      openTask('To do, High, undated', 'To do', 'High', null),
      openTask('In progress, Low, due tomorrow', 'In progress', 'Low', '2026-10-22'),
      openTask('In progress, Medium, due yesterday', 'In progress', 'Medium', '2026-10-20'),
      openTask('In progress, High, undated', 'In progress', 'High', null),
      openTask('In progress, High, long overdue', 'In progress', 'High', '2026-09-01'),
      doneTask('Done, High, past due', 'High', '2026-10-01', '2026-10-15T10:00:00.000Z'),
      doneTask('Done, Low, undated', 'Low', null, '2026-10-16T10:00:00.000Z'),
    ];

    it('counts open tasks by status and priority and the overdue ones, matching SQL', async () => {
      await seed(a.userId, SUMMARY_MIX);

      const body = await getPage(a.client, '/reports', 200);

      const counts = summaryCounts(body);
      expect(counts).toEqual(await summaryTruth(a.userId));
      // Done tasks count nowhere; due today and undated are not overdue.
      expect(counts).toEqual({
        'open-todo': 3,
        'open-in-progress': 4,
        'open-low': 2,
        'open-medium': 2,
        'open-high': 3,
        overdue: 3,
      });
    });

    it('shows every count as 0 with no tasks, and the empty completions message', async () => {
      const body = await getPage(a.client, '/reports', 200);

      expect(summaryCounts(body)).toEqual(ZERO_SUMMARY);
      expect(body).toContain(NO_COMPLETIONS);
    });

    it('judges overdue by the clock: a day later, a task due today is overdue', async () => {
      await seed(a.userId, SUMMARY_MIX);
      expect(summaryCounts(await getPage(a.client, '/reports', 200)).overdue).toBe(3);

      // A day later the 30-minute idle limit has ended A's session, so A logs in again.
      clock.advance(DAY_MS);
      const client = app.client();
      await logIn(client, a.email);

      const counts = summaryCounts(await getPage(client, '/reports', 200));
      expect(counts).toEqual(await summaryTruth(a.userId));
      // The task due 2026-10-21 joins the three overdue ones; the one due 2026-10-22 is due today.
      expect(counts).toEqual({
        'open-todo': 3,
        'open-in-progress': 4,
        'open-low': 2,
        'open-medium': 2,
        'open-high': 3,
        overdue: 4,
      });
    });
  });

  describe('completions (SC9, FR-12)', () => {
    /** Completions on UTC day boundaries, outside the range, and a reopened task. */
    const COMPLETIONS_MIX: readonly TaskFixture[] = [
      doneTask('Completed at the first instant of 10-01', 'Low', null, '2026-10-01T00:00:00.000Z'),
      doneTask('Completed at the end of 10-05', 'Medium', null, '2026-10-05T23:59:59.999Z'),
      doneTask('Completed at the first instant of 10-06', 'High', null, '2026-10-06T00:00:00.000Z'),
      doneTask('Completed early on 10-10', 'Low', null, '2026-10-10T00:30:00.000Z'),
      doneTask('Completed at noon on 10-10', 'Medium', null, '2026-10-10T12:00:00.000Z'),
      doneTask('Completed late on 10-10', 'High', null, '2026-10-10T23:30:00.000Z'),
      doneTask('Completed this morning', 'Medium', null, '2026-10-21T08:59:59.999Z'),
      doneTask('Completed before the range', 'Low', null, '2026-09-01T12:00:00.000Z'),
      // Completed and then reopened: the completion time was cleared, so it counts nowhere.
      {
        title: 'Reopened after completion',
        status: 'To do',
        priority: 'Medium',
        dueDate: null,
        createdAt: at('2026-10-02T09:00:00.000Z'),
        updatedAt: at('2026-10-09T09:00:00.000Z'),
        completedAt: null,
      },
    ];

    it('lists every day of the range in order with the SQL count of completions', async () => {
      await seed(a.userId, COMPLETIONS_MIX);

      const body = await getPage(a.client, '/reports?from=2026-10-01&to=2026-10-21', 200);

      const rows = completionRows(body);
      expect(rows).toHaveLength(21);
      expect(rows.map((row) => row.day)).toEqual(expectedDays('2026-10-01', '2026-10-21'));
      expect(rows).toEqual(await completionsTruth(a.userId, '2026-10-01', '2026-10-21'));
      const counted = rows.filter((row) => row.count > 0);
      expect(counted).toEqual([
        { day: '2026-10-01', count: 1 },
        { day: '2026-10-05', count: 1 },
        { day: '2026-10-06', count: 1 },
        { day: '2026-10-10', count: 3 },
        { day: '2026-10-21', count: 1 },
      ]);
      expect(body).not.toContain(NO_COMPLETIONS);
    });

    it.each(['/reports', '/reports?from=&to='])(
      'GET %s uses the default range: the 30 days ending today (UTC)',
      async (path) => {
        await seed(a.userId, COMPLETIONS_MIX);

        const rows = completionRows(await getPage(a.client, path, 200));

        expect(rows).toHaveLength(30);
        expect(rows[0]?.day).toBe('2026-09-22');
        expect(rows[29]?.day).toBe('2026-10-21');
        expect(rows).toEqual(await completionsTruth(a.userId, '2026-09-22', '2026-10-21'));
        expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(7);
      },
    );

    it('shows zero rows and the empty-period message when nothing was completed', async () => {
      await seed(a.userId, COMPLETIONS_MIX);

      const body = await getPage(a.client, '/reports?from=2026-11-01&to=2026-11-30', 200);

      const rows = completionRows(body);
      expect(rows.map((row) => row.day)).toEqual(expectedDays('2026-11-01', '2026-11-30'));
      expect(rows.every((row) => row.count === 0)).toBe(true);
      expect(body).toContain(NO_COMPLETIONS);
      expect(body).toContain('id="completions-table"');
      const figure = CHART_FIGURE_TAG.exec(body)?.[0];
      expect(figure).toBeDefined();
      expect(figure).toMatch(/\shidden[\s>]/);
    });
  });

  describe('range validation (FR-14)', () => {
    it.each([
      { query: 'from=2026-10-21&to=2026-10-01', message: START_AFTER_END },
      { query: 'from=2025-01-01&to=2026-01-02', message: RANGE_TOO_LONG },
      { query: 'from=2026-10-01', message: INVALID_DATES },
      { query: 'to=2026-10-21', message: INVALID_DATES },
      { query: 'from=2026-10-01&to=', message: INVALID_DATES },
      { query: 'from=2026-02-30&to=2026-03-01', message: INVALID_DATES },
    ])(
      'GET /reports?$query answers 422 "$message" with the summary and no data',
      async ({ query, message }) => {
        await seed(a.userId, [openTask('Still counted', 'To do', 'High', null)]);

        const body = await getPage(a.client, `/reports?${query}`, 422);

        expect(body).toContain(message);
        expect(body).toContain('data-testid="open-todo"');
        expect(summaryCounts(body)).toEqual({ ...ZERO_SUMMARY, 'open-todo': 1, 'open-high': 1 });
        expect(body).not.toContain('id="completions-table"');
        expect(body).not.toContain('id="completions-chart"');
        expect(completionRows(body)).toEqual([]);
        expect(body).not.toContain(NO_COMPLETIONS);
      },
    );

    it.each([
      { query: 'from=2025-01-01&to=2026-01-01', from: '2025-01-01', to: '2026-01-01', days: 366 },
      { query: 'from=2026-10-21&to=2026-10-21', from: '2026-10-21', to: '2026-10-21', days: 1 },
    ])(
      'GET /reports?$query is accepted with one row per day ($days)',
      async ({ query, from, to, days }) => {
        const rows = completionRows(await getPage(a.client, `/reports?${query}`, 200));

        expect(rows).toHaveLength(days);
        expect(rows.map((row) => row.day)).toEqual(expectedDays(from, to));
      },
    );
  });

  describe('CSV export (SC10, FR-13)', () => {
    /**
     * Tasks created on both edges of 2026-10-01 to 2026-10-21 and just outside it, with text
     * that needs RFC 4180 quoting, non-ASCII characters and a formula-like title.
     */
    const EXPORT_MIX: readonly TaskFixture[] = [
      {
        title: 'Plan, then "ship"',
        description: 'Line one\r\nLine two',
        status: 'To do',
        priority: 'High',
        dueDate: '2026-10-15',
        createdAt: at('2026-10-01T00:00:00.000Z'),
        completedAt: null,
      },
      {
        title: 'Created before the range',
        description: 'excluded',
        status: 'To do',
        priority: 'Low',
        dueDate: null,
        createdAt: at('2026-09-30T23:59:59.999Z'),
        completedAt: null,
      },
      {
        title: 'Plain task',
        description: '',
        status: 'To do',
        priority: 'Low',
        dueDate: null,
        createdAt: at('2026-10-05T12:00:00.000Z'),
        completedAt: null,
      },
      // Same creation instant as the task above: the export breaks the tie by id.
      {
        title: 'Same instant, later id',
        description: 'Tie broken by id',
        status: 'Done',
        priority: 'Medium',
        dueDate: '2026-10-06',
        createdAt: at('2026-10-05T12:00:00.000Z'),
        completedAt: at('2026-10-06T00:00:00.000Z'),
      },
      {
        title: 'Café 😀 crème',
        description: 'Ünïcødé, "quoted", and more',
        status: 'Done',
        priority: 'Medium',
        dueDate: '2026-10-11',
        createdAt: at('2026-10-10T08:15:30.123Z'),
        completedAt: at('2026-10-12T17:45:01.987Z'),
      },
      // Exported unchanged: values must equal the stored data, so no formula prefix is added.
      {
        title: '=SUM(1,2)',
        description: 'bare\nnewline',
        status: 'In progress',
        priority: 'Low',
        dueDate: null,
        createdAt: at('2026-10-21T23:59:59.999Z'),
        completedAt: null,
      },
      {
        title: 'Created after the range',
        description: 'excluded',
        status: 'Done',
        priority: 'High',
        dueDate: null,
        createdAt: at('2026-10-22T00:00:00.000Z'),
        completedAt: at('2026-10-22T00:00:00.000Z'),
      },
    ];

    it('sends the tasks created in the range as RFC 4180 records equal to the rows', async () => {
      await seed(a.userId, EXPORT_MIX);

      const res = await getExport(a.client, '2026-10-01', '2026-10-21', '');

      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect([...res.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(res.bytes.toString('utf8').endsWith('\r\n')).toBe(true);

      const parsed = parseCsv(res.bytes);
      expect(parsed.bom).toBe(true);
      expect(parsed.records[0]).toEqual(CSV_HEADER_RECORD);

      const stored = await tasksForOwner(pool, a.userId);
      const data = parsed.records.slice(1);
      expect(data).toEqual(expectedCsvRecords(stored, '2026-10-01', '2026-10-21', null));
      expect(data.map((record) => record[1])).toEqual([
        'Plan, then "ship"',
        'Plain task',
        'Same instant, later id',
        'Café 😀 crème',
        '=SUM(1,2)',
      ]);
      // The formula-like title is quoted only for its comma; nothing is prefixed to it.
      expect(res.body).toContain(',"=SUM(1,2)",');
      const timed = data.find((record) => record[1] === 'Café 😀 crème');
      expect(timed?.slice(5)).toEqual([
        '2026-10-11',
        '2026-10-10T08:15:30.123Z',
        '2026-10-12T17:45:01.987Z',
      ]);
    });

    it('filters the export by an exact status', async () => {
      await seed(a.userId, EXPORT_MIX);

      const res = await getExport(a.client, '2026-10-01', '2026-10-21', 'Done');

      const stored = await tasksForOwner(pool, a.userId);
      const data = parseCsv(res.bytes).records.slice(1);
      expect(data).toEqual(expectedCsvRecords(stored, '2026-10-01', '2026-10-21', 'Done'));
      expect(data).toHaveLength(2);
      expect(data.every((record) => record[3] === 'Done')).toBe(true);
    });

    it('sends only the header row when no task was created in the range', async () => {
      await seed(a.userId, EXPORT_MIX);

      const res = await getExport(a.client, '2026-11-01', '2026-11-30', '');

      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
      expect(res.body).toBe(HEADER_ONLY_EXPORT);
    });

    it('answers an invalid range with the 422 reports page and no file', async () => {
      await seed(a.userId, [openTask('Open and undated', 'In progress', 'Low', null)]);

      const res = await a.client.get('/reports/export?from=2026-10-21&to=2026-10-01&status=');

      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.body).toContain(START_AFTER_END);
      expect(summaryCounts(res.body)).toEqual({
        ...ZERO_SUMMARY,
        'open-in-progress': 1,
        'open-low': 1,
      });
      expect(res.body).toContain('id="completions-table"');
      expect(completionRows(res.body).map((row) => row.day)).toEqual(
        expectedDays('2026-09-22', '2026-10-21'),
      );
    });

    it('answers an unknown status with 422 "Choose a valid status." and no file', async () => {
      const res = await a.client.get('/reports/export?from=2026-10-01&to=2026-10-21&status=Urgent');

      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.body).toContain(INVALID_STATUS);
    });

    it('answers a repeated parameter with 400 "Bad request."', async () => {
      const res = await a.client.get(
        '/reports/export?from=2026-10-01&from=2026-10-02&to=2026-10-21',
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.body).toContain(BAD_REQUEST);
    });
  });

  describe('year 0001 and year 9999 endpoints (plan 0.5.3)', () => {
    it.each([
      { from: '9999-12-01', to: '9999-12-31' },
      { from: '0001-01-01', to: '0001-01-31' },
    ])('GET /reports?from=$from&to=$to lists 31 zero days', async ({ from, to }) => {
      const body = await getPage(a.client, `/reports?from=${from}&to=${to}`, 200);

      const rows = completionRows(body);
      expect(rows).toHaveLength(31);
      expect(rows[0]?.day).toBe(from);
      expect(rows[30]?.day).toBe(to);
      expect(rows.map((row) => row.day)).toEqual(expectedDays(from, to));
      expect(rows.every((row) => row.count === 0)).toBe(true);
      expect(body).toContain(NO_COMPLETIONS);
    });

    it('exports a task created at the last millisecond of 9999-12-31', async () => {
      clock.set('9999-12-31T23:59:59.999Z');
      // The session's expiry falls in year 10000, which PostgreSQL and pg both represent.
      const late = await signUpAndLogIn('year-9999@example.com');
      expect((await late.client.get('/tasks/new')).status).toBe(200);
      const created = await late.client.post('/tasks/new', {
        title: 'Created at the end of 9999',
        description: '',
        status: 'To do',
        priority: 'Medium',
        dueDate: '',
      });
      expect(created.status).toBe(303);
      expect(created.location).toBe('/tasks');

      const res = await getExport(late.client, '9999-12-31', '9999-12-31', '');

      const records = parseCsv(res.bytes).records;
      expect(records).toHaveLength(2);
      expect(records[1]?.[1]).toBe('Created at the end of 9999');
      expect(records[1]?.[6]).toBe('9999-12-31T23:59:59.999Z');
      const stored = await tasksForOwner(pool, late.userId);
      const expected = expectedCsvRecords(stored, '9999-12-31', '9999-12-31', null);
      expect(records.slice(1)).toEqual(expected);

      // Today is 9999-12-31, so the default range is 9999-12-02 to 9999-12-31.
      const rows = completionRows(await getPage(late.client, '/reports', 200));
      expect(rows.map((row) => row.day)).toEqual(expectedDays('9999-12-02', '9999-12-31'));
    });
  });

  describe('access and isolation (SC7)', () => {
    it.each(['/reports', '/reports/export?from=2026-10-01&to=2026-10-21&status=Done'])(
      'redirects an unauthenticated GET %s to the login page with the return path',
      async (path) => {
        const res = await app.client().get(path);

        expect(res.status).toBe(302);
        expect(res.location).toBe(`/login?next=${encodeURIComponent(path)}`);
        expect(res.headers.get('content-disposition')).toBeNull();
      },
    );

    describe('with tasks for user A only', () => {
      /** A's titles, none of which may reach B's pages or files. */
      const A_TITLES: readonly string[] = [
        'Owner A confidential roadmap',
        'Owner A overdue invoice',
        'Owner A finished audit',
      ];

      let b: Account;

      beforeEach(async () => {
        await seed(a.userId, [
          {
            title: 'Owner A confidential roadmap',
            status: 'To do',
            priority: 'High',
            dueDate: '2026-10-30',
            createdAt: at('2026-10-02T09:00:00.000Z'),
            completedAt: null,
          },
          {
            title: 'Owner A overdue invoice',
            status: 'In progress',
            priority: 'Low',
            dueDate: '2026-10-01',
            createdAt: at('2026-10-03T09:00:00.000Z'),
            completedAt: null,
          },
          {
            title: 'Owner A finished audit',
            status: 'Done',
            priority: 'Medium',
            dueDate: '2026-10-05',
            createdAt: at('2026-10-04T09:00:00.000Z'),
            completedAt: at('2026-10-15T09:00:00.000Z'),
          },
        ]);
        b = await signUpAndLogIn('owner-b@example.com');
      });

      it("shows B none of A's tasks in the summary, completions or export", async () => {
        // A's own reports include the tasks, so B's zeros are isolation, not an empty seed.
        const aBody = await getPage(a.client, '/reports', 200);
        expect(summaryCounts(aBody)).toEqual({
          'open-todo': 1,
          'open-in-progress': 1,
          'open-low': 1,
          'open-medium': 0,
          'open-high': 1,
          overdue: 1,
        });
        expect(completionRows(aBody).find((row) => row.day === '2026-10-15')?.count).toBe(1);
        const aExport = await getExport(a.client, '2026-09-22', '2026-10-21', '');
        for (const title of A_TITLES) {
          expect(aExport.body).toContain(title);
        }

        const summaryPage = await getPage(b.client, '/reports', 200);
        expect(summaryCounts(summaryPage)).toEqual(ZERO_SUMMARY);
        const defaultRows = completionRows(summaryPage);
        expect(defaultRows).toHaveLength(30);
        expect(defaultRows.every((row) => row.count === 0)).toBe(true);
        expect(summaryPage).toContain(NO_COMPLETIONS);

        const rangePage = await getPage(b.client, '/reports?from=2026-10-01&to=2026-10-21', 200);
        expect(completionRows(rangePage).every((row) => row.count === 0)).toBe(true);
        expect(rangePage).toContain(NO_COMPLETIONS);

        const allExport = await getExport(b.client, '2026-09-22', '2026-10-21', '');
        expect(allExport.body).toBe(HEADER_ONLY_EXPORT);
        const doneExport = await getExport(b.client, '2026-09-22', '2026-10-21', 'Done');
        expect(doneExport.body).toBe(HEADER_ONLY_EXPORT);

        for (const body of [summaryPage, rangePage, allExport.body, doneExport.body]) {
          for (const title of A_TITLES) {
            expect(body).not.toContain(title);
          }
        }
      });
    });
  });
});

/** The instant every default fixture timestamp carries. */
const FIXTURE_ISO = '2026-10-21T09:00:00.000Z';

/** Zero-based positions of `created_at`, `updated_at` and `completed_at` among the bound values. */
const CREATED_AT_INDEX = 6;
const UPDATED_AT_INDEX = 7;
const COMPLETED_AT_INDEX = 8;

/** A fake database and the values bound to each statement it received, in order. */
interface RecordingDatabase {
  db: Queryable;
  bound: unknown[][];
}

/**
 * Builds a `Queryable` that records every statement's bound values and answers each with one row,
 * which is all `insertTask` reads back.
 */
function createRecordingDatabase(): RecordingDatabase {
  const bound: unknown[][] = [];
  const fake = {
    async query(_text: string, values: unknown[]): Promise<{ rows: unknown[] }> {
      bound.push(values);
      return { rows: [{ id: bound.length }] };
    },
  };
  // Only `query` is used by the fixture, so the fake stands in for a pool.
  return { db: fake as unknown as Queryable, bound };
}

/**
 * Returns the `Date` bound at `index` of one statement's values.
 *
 * @throws Error when the statement is missing or the value there is not a `Date`.
 */
function boundDate(values: unknown[] | undefined, index: number): Date {
  const value = values?.[index];
  if (!(value instanceof Date)) {
    throw new Error(`bound value ${index} is not a Date`);
  }
  return value;
}

// `FIXTURE_TIME` is an exported `Date`, and a `Date` stays mutable through `setTime` and its
// setters even when frozen. The defaults are therefore built afresh from a private epoch on every
// call, so a test that moves `FIXTURE_TIME` cannot shift the timestamps of any later fixture.
describe('insertTask timestamp defaults', () => {
  afterEach(() => {
    // Undo any mutation, so this file leaves FIXTURE_TIME as every other importer expects it.
    FIXTURE_TIME.setTime(Date.parse(FIXTURE_ISO));
  });

  it(`exports FIXTURE_TIME at ${FIXTURE_ISO}`, () => {
    expect(FIXTURE_TIME.toISOString()).toBe(FIXTURE_ISO);
  });

  it.each([
    { mutation: 'setTime(0)', mutate: (date: Date): number => date.setTime(0) },
    {
      mutation: 'setUTCFullYear(1999)',
      mutate: (date: Date): number => date.setUTCFullYear(1999),
    },
  ])(
    `binds ${FIXTURE_ISO} for every default after FIXTURE_TIME.$mutation`,
    async ({ mutate }) => {
      mutate(FIXTURE_TIME);
      expect(FIXTURE_TIME.toISOString()).not.toBe(FIXTURE_ISO);
      const { db, bound } = createRecordingDatabase();

      await insertTask(db, 1);
      await insertTask(db, 1, { status: 'Done' });

      const [open, done] = bound;
      expect(boundDate(open, CREATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(open, UPDATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(open?.[COMPLETED_AT_INDEX]).toBeNull();
      expect(boundDate(open, CREATED_AT_INDEX)).not.toBe(FIXTURE_TIME);
      expect(boundDate(done, CREATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, UPDATED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, COMPLETED_AT_INDEX).toISOString()).toBe(FIXTURE_ISO);
      expect(boundDate(done, CREATED_AT_INDEX)).not.toBe(FIXTURE_TIME);
    },
  );

  it('binds a distinct Date object on each default call', async () => {
    const { db, bound } = createRecordingDatabase();

    await insertTask(db, 1);
    await insertTask(db, 1);

    const first = boundDate(bound[0], CREATED_AT_INDEX);
    const second = boundDate(bound[1], CREATED_AT_INDEX);
    expect(first).not.toBe(second);
    expect(first.toISOString()).toBe(FIXTURE_ISO);
    expect(second.toISOString()).toBe(FIXTURE_ISO);
  });
});

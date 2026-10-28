/**
 * Integration tests for `GET /reports` and `GET /reports/export` against real PostgreSQL 16
 * (plan 0.8.1, 0.9.1 SC7–SC11, 0.5.3 and 0.5.4).
 *
 * Every page and file is compared with "database truth": counts and rows read straight from the
 * `tasks` table with independent SQL, never through the report module. Expected literal values
 * are asserted beside the SQL, so the query and the page cannot both be wrong in the same way.
 * The completions table is read from the date and count cells it displays, and the `data-day`
 * and `data-count` attributes the chart reads must equal those cells.
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

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import type { Queryable } from '../../src/db/query';
import type { ReportService } from '../../src/reports/report-service';

import { parseCsv } from '../helpers/csv-parse';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import type { HttpClient, HttpResult } from '../helpers/http-client';
import { gateAuthenticate, sendHeldGet, startTestApp } from '../helpers/test-app';
import type { AuthGate, TestApp } from '../helpers/test-app';
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

/**
 * Password of every account these tests create, generated afresh on each run so no secret is
 * fixed in the source. It meets the sign-up policy: 27 code points and 27 UTF-8 bytes, with the
 * fixed prefix supplying a letter and the fixed suffix a decimal digit.
 */
const PASSWORD = 'Pw' + randomBytes(12).toString('hex') + '9';

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

/**
 * How a report date input renders: `date` is the date control, and `text` is the text field
 * that holds an entered value a date control would sanitise to empty (plan 0.5.5).
 */
type DateField = 'date' | 'text';

/** A rejected completions range: its query, its message and how From and To re-render. */
interface RangeFailureCase {
  query: string;
  message: string;
  /** The rendering of the From and To inputs, in that order. */
  fields: readonly [DateField, DateField];
}

/** A reports page and how its completions date fields are described and where it puts focus. */
interface CompletionsFocusCase {
  name: string;
  path: string;
  status: number;
  /** The `aria-describedby` value of both completions date fields. */
  describedBy: string;
  /** Whether both completions date fields carry `aria-invalid="true"`. */
  invalid: boolean;
  /** The role of `#completions-message`: the range message or the empty-period notice. */
  messageRole: 'alert' | 'status';
  /** The id of the page's one `autofocus` element. */
  autofocus: string | null;
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

/** The opening tag of the completions table, whatever its attribute order. */
const COMPLETIONS_TABLE_TAG = /<table\b[^>]*\sid="completions-table"[^>]*>/;

/** A table body's content up to its closing tag. */
const TABLE_BODY = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g;

/** A table row: its opening tag's attributes and its content up to the closing tag. */
const TABLE_ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;

/** A header cell: its opening tag's attributes and its content up to the closing tag. */
const HEADER_CELL = /<th\b([^>]*)>([\s\S]*?)<\/th>/g;

/** A data cell's content up to its closing tag. */
const DATA_CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/g;

/** A count as the page writes it: decimal digits only, so a blank cell is not read as 0. */
const COUNT_TEXT = /^\d+$/;

/** The opening tag of the chart figure, whatever its attribute order. */
const CHART_FIGURE_TAG = /<figure\b[^>]*\sid="completions-chart"[^>]*>/;

/** The content of the chart figure's caption, its first child, up to the closing tag. */
const CHART_CAPTION = new RegExp(
  `${CHART_FIGURE_TAG.source}\\s*<figcaption>([\\s\\S]*?)</figcaption>`,
);

/** A `<time>` element: its `datetime` value and its text. */
const TIME_ELEMENT = /<time datetime="([^"]*)">([^<]*)<\/time>/g;

/** The export section's message element and its text, whatever its attribute order. */
const EXPORT_MESSAGE = /<p\b[^>]*\sid="export-message"[^>]*>([^<]*)<\/p>/;

/** The export Status select's content, whatever its opening tag's attribute order. */
const EXPORT_STATUS_SELECT = /<select\b[^>]*\sid="export-status"[^>]*>([\s\S]*?)<\/select>/;

/** One `<option>` element, from its opening tag to its closing tag. */
const OPTION = /<option\b[^>]*>[^<]*<\/option>/g;

/** Every `autofocus` attribute on a page. */
const AUTOFOCUS_ALL = /\sautofocus(?=[\s>])/g;

/** An `autofocus` attribute within one tag. */
const AUTOFOCUS = /\sautofocus(?=[\s>])/;

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

/**
 * Reads the completions table as the page displays it: for each row of the `tbody` of
 * `<table id="completions-table">`, in document order, the trimmed text of its one
 * `<th scope="row">` (the date) and of its one `<td>` (the count). It also asserts that the
 * `data-day` and `data-count` attributes the chart reads from each row equal those cells.
 *
 * @returns The displayed rows, or `[]` when the page renders no completions table.
 * @throws Error when the table is unclosed or lacks a single `tbody`, or a row lacks either
 *   attribute, its single row header or its single data cell, or a count is not decimal digits.
 */
function completionRows(body: string): DayRow[] {
  const open = COMPLETIONS_TABLE_TAG.exec(body);
  if (open === null) {
    return [];
  }
  const start = open.index + open[0].length;
  const end = body.indexOf('</table>', start);
  if (end === -1) {
    throw new Error('completions table has no closing tag');
  }
  const bodies = [...body.slice(start, end).matchAll(TABLE_BODY)];
  const tbody = bodies[0]?.[1];
  if (bodies.length !== 1 || tbody === undefined) {
    throw new Error(`completions table has ${bodies.length} tbody elements, not 1`);
  }
  const cells: DayRow[] = [];
  const metadata: DayRow[] = [];
  for (const [index, row] of [...tbody.matchAll(TABLE_ROW)].entries()) {
    const where = `completions row ${index + 1}`;
    const attributes = row[1] ?? '';
    const dataDay = /\sdata-day="([^"]*)"/.exec(attributes)?.[1];
    const dataCount = /\sdata-count="([^"]*)"/.exec(attributes)?.[1];
    if (dataDay === undefined || dataCount === undefined) {
      throw new Error(`${where} lacks data-day or data-count`);
    }
    const content = row[2] ?? '';
    const headers = [...content.matchAll(HEADER_CELL)];
    const header = headers[0];
    if (headers.length !== 1 || header === undefined) {
      throw new Error(`${where} has ${headers.length} <th> cells, not 1`);
    }
    if (!/\sscope="row"/.test(header[1] ?? '')) {
      throw new Error(`${where} has a <th> without scope="row"`);
    }
    const data = [...content.matchAll(DATA_CELL)];
    const cell = data[0];
    if (data.length !== 1 || cell === undefined) {
      throw new Error(`${where} has ${data.length} <td> cells, not 1`);
    }
    const day = (header[2] ?? '').trim();
    const count = (cell[1] ?? '').trim();
    if (!COUNT_TEXT.test(count) || !COUNT_TEXT.test(dataCount)) {
      throw new Error(`${where} count "${count}" or data-count "${dataCount}" is not digits`);
    }
    cells.push({ day, count: Number(count) });
    metadata.push({ day: dataDay, count: Number(dataCount) });
  }
  // The chart draws its bars from the attributes, so they must equal what the table shows.
  expect(metadata).toEqual(cells);
  return cells;
}

/** Reads the `value` of the `<input>` carrying `id="<id>"`, whatever its attribute order. */
function inputValue(body: string, id: string): string {
  const tag = new RegExp(`<input\\b(?=[^>]*\\sid="${id}")[^>]*\\svalue="([^"]*)"`);
  const value = tag.exec(body)?.[1];
  if (value === undefined) {
    throw new Error(`input "${id}" with a value not found on the page`);
  }
  return value;
}

/** Returns the whole `<input ...>` tag carrying `id="<id>"`, whatever its attribute order. */
function inputTag(body: string, id: string): string {
  const tag = new RegExp(`<input\\b(?=[^>]*\\sid="${id}")[^>]*>`).exec(body)?.[0];
  if (tag === undefined) {
    throw new Error(`input "${id}" not found on the page`);
  }
  return tag;
}

/** Returns the start tag of any element carrying `id="<id>"`, whatever its attribute order. */
function startTag(body: string, id: string): string {
  const tag = new RegExp(`<[a-z]+\\b(?=[^>]*\\sid="${id}")[^>]*>`).exec(body)?.[0];
  if (tag === undefined) {
    throw new Error(`element "${id}" not found on the page`);
  }
  return tag;
}

/**
 * Asserts that the `<input>` carrying `id="<id>"` renders as `field`: a `type="date"` control
 * without the fallback's attributes, or a `type="text"` field with `inputmode="numeric"` and
 * `placeholder="YYYY-MM-DD"`.
 */
function expectDateField(body: string, id: string, field: DateField): void {
  const tag = inputTag(body, id);
  expect(tag).toMatch(new RegExp(`\\stype="${field}"`));
  if (field === 'text') {
    expect(tag).toMatch(/\sinputmode="numeric"/);
    expect(tag).toMatch(/\splaceholder="YYYY-MM-DD"/);
  } else {
    expect(tag).not.toMatch(/\sinputmode=/);
    expect(tag).not.toMatch(/\splaceholder=/);
  }
}

/**
 * Returns every `<option>` element of the export Status select as written, in document order.
 *
 * @throws Error when the page has no select carrying `id="export-status"`.
 */
function exportStatusOptions(body: string): string[] {
  const options = EXPORT_STATUS_SELECT.exec(body)?.[1];
  if (options === undefined) {
    throw new Error('export status select not found on the page');
  }
  return [...options.matchAll(OPTION)].map((match) => match[0]);
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

/** Calls a counting report service has received, by method. */
interface ReportCalls {
  summary: number;
  completions: number;
  exportCsv: number;
}

/** A read-only reports request and what its handler does for a client that stays connected. */
interface HeldReportGet {
  name: string;
  path: string;
  /** The status answered to a connected client. */
  status: number;
  /** The report queries made for a connected client. */
  calls: ReportCalls;
}

/** The counts of a request that made no report query. */
const NO_REPORT_CALLS: Readonly<ReportCalls> = { summary: 0, completions: 0, exportCsv: 0 };

const HELD_REPORT_GETS: readonly HeldReportGet[] = [
  {
    name: 'GET /reports',
    path: '/reports',
    status: 200,
    calls: { summary: 1, completions: 1, exportCsv: 0 },
  },
  {
    name: 'GET /reports/export',
    path: '/reports/export?from=2026-10-01&to=2026-10-21&status=',
    status: 200,
    calls: { summary: 0, completions: 0, exportCsv: 1 },
  },
  {
    name: 'GET /reports/export with a reversed range',
    path: '/reports/export?from=2026-10-21&to=2026-10-01&status=',
    status: 422,
    calls: { summary: 1, completions: 1, exportCsv: 0 },
  },
];

/** Wraps the real report service so that each query method counts its calls before running. */
function countingReports(real: ReportService, calls: ReportCalls): ReportService {
  return {
    ...real,
    summary(ownerId): ReturnType<ReportService['summary']> {
      calls.summary += 1;
      return real.summary(ownerId);
    },
    completions(ownerId, range): ReturnType<ReportService['completions']> {
      calls.completions += 1;
      return real.completions(ownerId, range);
    },
    exportCsv(ownerId, range, status): ReturnType<ReportService['exportCsv']> {
      calls.exportCsv += 1;
      return real.exportCsv(ownerId, range, status);
    },
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
    try {
      await app.close();
    } finally {
      await pool.end();
    }
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

    it('GET /reports uses the default range: the 30 days ending today (UTC)', async () => {
      await seed(a.userId, COMPLETIONS_MIX);

      const body = await getPage(a.client, '/reports', 200);
      const rows = completionRows(body);

      expect(rows).toHaveLength(30);
      expect(rows[0]?.day).toBe('2026-09-22');
      expect(rows[29]?.day).toBe('2026-10-21');
      expect(rows).toEqual(await completionsTruth(a.userId, '2026-09-22', '2026-10-21'));
      expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(7);
      // Both forms are prefilled with the default range, whose real dates stay date controls.
      for (const prefix of ['completions', 'export']) {
        expect(inputValue(body, `${prefix}-from`)).toBe('2026-09-22');
        expect(inputValue(body, `${prefix}-to`)).toBe('2026-10-21');
        expectDateField(body, `${prefix}-from`, 'date');
        expectDateField(body, `${prefix}-to`, 'date');
      }
    });

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
    // `fields` gives how From and To re-render: a real date stays a date control, while a blank,
    // unsent or impossible date fails and so becomes the text field holding what was entered.
    it.each<RangeFailureCase>([
      {
        query: 'from=2026-10-21&to=2026-10-01',
        message: START_AFTER_END,
        fields: ['date', 'date'],
      },
      { query: 'from=2025-01-01&to=2026-01-02', message: RANGE_TOO_LONG, fields: ['date', 'date'] },
      { query: 'from=2026-10-01', message: INVALID_DATES, fields: ['date', 'text'] },
      { query: 'to=2026-10-21', message: INVALID_DATES, fields: ['text', 'date'] },
      { query: 'from=2026-10-01&to=', message: INVALID_DATES, fields: ['date', 'text'] },
      { query: 'from=2026-02-30&to=2026-03-01', message: INVALID_DATES, fields: ['text', 'date'] },
      // Blank dates are supplied values, so they fail rather than select the default range.
      { query: 'from=&to=', message: INVALID_DATES, fields: ['text', 'text'] },
      { query: 'from=', message: INVALID_DATES, fields: ['text', 'text'] },
      { query: 'to=', message: INVALID_DATES, fields: ['text', 'text'] },
    ])(
      'GET /reports?$query answers 422 "$message" with the summary and no data',
      async ({ query, message, fields: [fromField, toField] }) => {
        await seed(a.userId, [openTask('Still counted', 'To do', 'High', null)]);

        const body = await getPage(a.client, `/reports?${query}`, 422);

        expect(body).toContain(message);
        // The range form keeps the dates as entered, a blank or unsent one as an empty field.
        const entered = new URLSearchParams(query);
        expect(inputValue(body, 'completions-from')).toBe(entered.get('from') ?? '');
        expect(inputValue(body, 'completions-to')).toBe(entered.get('to') ?? '');
        expectDateField(body, 'completions-from', fromField);
        expectDateField(body, 'completions-to', toField);
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
      'GET /reports?$query is accepted with one row per day ($days) and the range as its caption',
      async ({ query, from, to, days }) => {
        const body = await getPage(a.client, `/reports?${query}`, 200);
        const rows = completionRows(body);

        expect(rows).toHaveLength(days);
        expect(rows.map((row) => row.day)).toEqual(expectedDays(from, to));
        // Each date is its own `<time>` element, which CSS keeps on one line, and the caption
        // still reads as plain text.
        const caption = CHART_CAPTION.exec(body)?.[1] ?? '';
        const times = [...caption.matchAll(TIME_ELEMENT)].map(([, datetime, text]) => [
          datetime,
          text,
        ]);
        expect(times).toEqual([
          [from, from],
          [to, to],
        ]);
        expect(caption.replace(/<[^>]*>/g, '')).toBe(
          `Tasks completed per day, ${from} to ${to} (UTC)`,
        );
      },
    );

    // The range message is what describes the dates and takes focus: the browser scrolls a
    // focused element into view, and the message sits below the form, out of view on a phone.
    // The empty-period notice shares the message's id but describes neither date, and a failed
    // export focuses its own field.
    it.each<CompletionsFocusCase>([
      {
        name: 'a valid range with no completions',
        path: '/reports?from=2026-11-01&to=2026-11-30',
        status: 200,
        describedBy: 'completions-hint',
        invalid: false,
        messageRole: 'status',
        autofocus: null,
      },
      {
        name: 'a start date after the end date',
        path: '/reports?from=2026-10-21&to=2026-10-01',
        status: 422,
        describedBy: 'completions-hint completions-message',
        invalid: true,
        messageRole: 'alert',
        autofocus: 'completions-message',
      },
      {
        name: 'blank dates',
        path: '/reports?from=&to=',
        status: 422,
        describedBy: 'completions-hint completions-message',
        invalid: true,
        messageRole: 'alert',
        autofocus: 'completions-message',
      },
      {
        name: 'a failed export beside a default range with no completions',
        path: '/reports/export?from=2026-10-21&to=2026-10-01&status=',
        status: 422,
        describedBy: 'completions-hint',
        invalid: false,
        messageRole: 'status',
        autofocus: 'export-from',
      },
    ])(
      '$name: the dates are described by "$describedBy"; autofocus: $autofocus',
      async ({ path, status, describedBy, invalid, messageRole, autofocus }) => {
        const body = await getPage(a.client, path, status);

        for (const id of ['completions-from', 'completions-to']) {
          const tag = inputTag(body, id);
          expect(tag).toMatch(new RegExp(`\\saria-describedby="${describedBy}"`));
          expect(/\saria-invalid="true"/.test(tag)).toBe(invalid);
        }
        const message = startTag(body, 'completions-message');
        expect(message).toMatch(new RegExp(`\\srole="${messageRole}"`));
        // Only the range message is focusable, and `-1` keeps it out of the tab order.
        expect(/\stabindex="-1"/.test(message)).toBe(messageRole === 'alert');
        expect(body.match(AUTOFOCUS_ALL) ?? []).toHaveLength(autofocus === null ? 0 : 1);
        if (autofocus !== null) {
          expect(startTag(body, autofocus)).toMatch(AUTOFOCUS);
        }
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

    it('exports the default range when neither date is sent', async () => {
      await seed(a.userId, EXPORT_MIX);

      const res = await a.client.get('/reports/export');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="tasks-2026-09-22-to-2026-10-21.csv"',
      );
      const stored = await tasksForOwner(pool, a.userId);
      const data = parseCsv(res.bytes).records.slice(1);
      expect(data).toEqual(expectedCsvRecords(stored, '2026-09-22', '2026-10-21', null));
      expect(data).toHaveLength(6);
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

    // Blank dates are supplied values, so they fail rather than export the default range.
    it.each(['from=&to=&status=', 'from=&status=', 'to=&status='])(
      'GET /reports/export?%s answers 422 with the blanks kept and no file',
      async (query) => {
        await seed(a.userId, [openTask('Open and undated', 'In progress', 'Low', null)]);

        const res = await a.client.get(`/reports/export?${query}`);

        expect(res.status).toBe(422);
        expect(res.headers.get('content-type')).toMatch(/^text\/html/);
        expect(res.headers.get('content-disposition')).toBeNull();
        expect(res.body).toContain(INVALID_DATES);
        expect(summaryCounts(res.body)).toEqual({
          ...ZERO_SUMMARY,
          'open-in-progress': 1,
          'open-low': 1,
        });
        expect(completionRows(res.body).map((row) => row.day)).toEqual(
          expectedDays('2026-09-22', '2026-10-21'),
        );
        expect(inputValue(res.body, 'export-from')).toBe('');
        expect(inputValue(res.body, 'export-to')).toBe('');
        expectDateField(res.body, 'export-from', 'text');
        expectDateField(res.body, 'export-to', 'text');
      },
    );

    it('answers blank dates and an unknown status with the range message and no file', async () => {
      const res = await a.client.get('/reports/export?from=&to=&status=Urgent');

      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-disposition')).toBeNull();
      // The range is checked first, so its message is the one shown.
      expect(res.body).toContain(INVALID_DATES);
      expect(res.body).not.toContain(INVALID_STATUS);
      expect(res.body).toContain('<option value="Urgent" selected>Urgent (invalid)</option>');
      // The select carries the invalid flag, yet the blanks failed too and stay text fields.
      expect(inputValue(res.body, 'export-from')).toBe('');
      expect(inputValue(res.body, 'export-to')).toBe('');
      expectDateField(res.body, 'export-from', 'text');
      expectDateField(res.body, 'export-to', 'text');
    });

    it('answers an unknown status with the 422 reports page and no file', async () => {
      // Open tasks give every summary count a value. The completions fall before the default
      // range, on its first day, inside it but before the export range, and inside both, so
      // only the default range's 30 days give the expected rows.
      await seed(a.userId, [
        openTask('To do, High, due yesterday', 'To do', 'High', '2026-10-20'),
        openTask('To do, Low, undated', 'To do', 'Low', null),
        openTask('In progress, Medium, due today', 'In progress', 'Medium', '2026-10-21'),
        doneTask('Completed before the default range', 'Low', null, '2026-09-21T23:59:59.999Z'),
        doneTask('Completed on the first default day', 'Medium', null, '2026-09-22T00:00:00.000Z'),
        doneTask('Completed before the export range', 'High', null, '2026-09-25T12:00:00.000Z'),
        doneTask('Completed early on 10-10', 'Low', null, '2026-10-10T08:00:00.000Z'),
        doneTask('Completed late on 10-10', 'Medium', null, '2026-10-10T20:00:00.000Z'),
      ]);

      const res = await a.client.get('/reports/export?from=2026-10-01&to=2026-10-21&status=Urgent');

      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.body).toContain(INVALID_STATUS);
      // The message is the export section's, not the completions section's.
      expect(EXPORT_MESSAGE.exec(res.body)?.[1]).toBe(INVALID_STATUS);

      // The reports page continues: the summary is the owner's whole open workload.
      const counts = summaryCounts(res.body);
      expect(counts).toEqual(await summaryTruth(a.userId));
      expect(counts).toEqual({
        'open-todo': 2,
        'open-in-progress': 1,
        'open-low': 1,
        'open-medium': 1,
        'open-high': 1,
        overdue: 1,
      });

      // The completions are the default range's, never the requested export range.
      const rows = completionRows(res.body);
      expect(rows).toHaveLength(30);
      expect(rows.map((row) => row.day)).toEqual(expectedDays('2026-09-22', '2026-10-21'));
      expect(rows).toEqual(await completionsTruth(a.userId, '2026-09-22', '2026-10-21'));
      expect(rows.filter((row) => row.count > 0)).toEqual([
        { day: '2026-09-22', count: 1 },
        { day: '2026-09-25', count: 1 },
        { day: '2026-10-10', count: 2 },
      ]);
      expect(res.body).not.toContain(NO_COMPLETIONS);
      expect(inputValue(res.body, 'completions-from')).toBe('2026-09-22');
      expect(inputValue(res.body, 'completions-to')).toBe('2026-10-21');
      expectDateField(res.body, 'completions-from', 'date');
      expectDateField(res.body, 'completions-to', 'date');

      // The export form keeps the entered values: the valid dates stay date controls, and the
      // unknown status is one extra selected option, with no listed status selected.
      expect(inputValue(res.body, 'export-from')).toBe('2026-10-01');
      expect(inputValue(res.body, 'export-to')).toBe('2026-10-21');
      expectDateField(res.body, 'export-from', 'date');
      expectDateField(res.body, 'export-to', 'date');
      expect(exportStatusOptions(res.body)).toEqual([
        '<option value="">All</option>',
        '<option value="To do">To do</option>',
        '<option value="In progress">In progress</option>',
        '<option value="Done">Done</option>',
        '<option value="Urgent" selected>Urgent (invalid)</option>',
      ]);
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

  describe('requests abandoned by the client', () => {
    /**
     * Starts a second instance that accepts `app`'s session cookies, holds each request at `gate`
     * in `loadSession` and counts the queries of `app`'s real report service.
     */
    function startHeldApp(gate: AuthGate, calls: ReportCalls): Promise<TestApp> {
      return startTestApp({
        clock,
        sessionSecret: app.config.sessionSecret,
        overrides: { auth: gate.auth, reports: countingReports(app.reports, calls) },
      });
    }

    /** User A's signed session cookie as a `Cookie` request header. */
    function sessionCookie(): string {
      const sid = a.client.cookie('sid');
      if (sid === undefined) {
        throw new Error('sessionCookie: user A holds no session cookie');
      }
      return `sid=${sid}`;
    }

    it.each(HELD_REPORT_GETS)('$name abandoned while held runs no report query', async (c) => {
      const gate = gateAuthenticate(app.auth);
      const calls: ReportCalls = { ...NO_REPORT_CALLS };
      const held = await startHeldApp(gate, calls);
      try {
        const status = await sendHeldGet(held, gate, c.path, sessionCookie(), 'abandon');

        expect(status).toBeNull();
        // The session was valid, so only the closed connection kept the handler from querying.
        expect(await gate.answered).toMatchObject({ id: a.userId });
        expect(calls).toEqual(NO_REPORT_CALLS);
      } finally {
        await held.close();
      }
    });

    it.each(HELD_REPORT_GETS)(
      '$name from a client still connected runs its queries and answers $status',
      async (c) => {
        const gate = gateAuthenticate(app.auth);
        const calls: ReportCalls = { ...NO_REPORT_CALLS };
        const held = await startHeldApp(gate, calls);
        try {
          const status = await sendHeldGet(held, gate, c.path, sessionCookie(), 'answer');

          expect(status).toBe(c.status);
          expect(calls).toEqual(c.calls);
        } finally {
          await held.close();
        }
      },
    );
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

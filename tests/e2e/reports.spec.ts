/**
 * End-to-end checks of the reports page and the CSV export in Chromium: the zero summary and the
 * empty completions table, summary counts after tasks are created through the browser, the
 * completions chart drawn from (and identical to) the table, the table-only fallback without
 * JavaScript, range validation, and the downloaded CSV compared field by field with the database.
 *
 * Each test signs up its own user, so tests share no data and run safely in parallel workers.
 *
 * "Today" is computed here in UTC and cross-checked against the server through the completions
 * form's To field, which the server prefills with its own today. A test that runs across midnight
 * UTC can therefore fail at that check; that flake risk is accepted, because the alternative (a
 * fake clock) is not available to the real server these specs drive.
 *
 * Expected messages and the CSV header are literals rather than imports from the code under test,
 * so the specs check the server against the plan instead of echoing it.
 */

import { readFile } from 'node:fs/promises';

import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

import { addDays, todayUtc, type IsoDate } from '../../src/shared/dates';
import { parseCsv } from '../helpers/csv-parse';
import { createTask, signUpAndLogIn, userTasks } from './support';

/** Length of the default completions range: today − 29 to today, both included. */
const DEFAULT_RANGE_DAYS = 30;

const NO_COMPLETIONS_MESSAGE = 'No tasks were completed in this period.';
const START_AFTER_END_MESSAGE = 'Start date must be on or before end date.';

/** The export's header row, in column order. */
const EXPECTED_CSV_HEADER = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'due date',
  'created time',
  'completed time',
] as const;

/** The `data-testid`s of the six summary counts. */
const SUMMARY_TEST_IDS = [
  'open-todo',
  'open-in-progress',
  'open-low',
  'open-medium',
  'open-high',
  'overdue',
] as const;

type SummaryTestId = (typeof SUMMARY_TEST_IDS)[number];

/** Every summary count at zero: a user with no open tasks. */
const ZERO_SUMMARY: Readonly<Record<SummaryTestId, number>> = {
  'open-todo': 0,
  'open-in-progress': 0,
  'open-low': 0,
  'open-medium': 0,
  'open-high': 0,
  overdue: 0,
};

/** A task row as read from the database by `userTasks`. */
type StoredTask = Awaited<ReturnType<typeof userTasks>>[number];

/** The `data-day` and `data-count` attributes of a table row or a chart bar, as rendered. */
interface DayCountAttributes {
  day: string | null;
  count: string | null;
}

/** The completions range form, `GET /reports`. */
function completionsForm(page: Page): Locator {
  return page.locator('form[action="/reports"]');
}

/** The CSV export form, `GET /reports/export`. */
function exportForm(page: Page): Locator {
  return page.locator('form[action="/reports/export"]');
}

/** The completions table's day rows; the header row sits in `thead` and is not matched. */
function completionRows(page: Page): Locator {
  return page.locator('#completions-table tbody tr');
}

/** The chart's bars: the only `rect` elements the chart script draws. */
function chartBars(page: Page): Locator {
  return page.locator('#completions-chart rect');
}

/** The days of the default range, oldest first, ending with `today`. */
function defaultRangeDays(today: IsoDate): IsoDate[] {
  return Array.from({ length: DEFAULT_RANGE_DAYS }, (_, i) =>
    addDays(today, i - (DEFAULT_RANGE_DAYS - 1)),
  );
}

/** Reads `data-day` and `data-count` from every matched element, in document order. */
function dayCountAttributes(locator: Locator): Promise<DayCountAttributes[]> {
  return locator.evaluateAll((elements) =>
    elements.map((el) => ({
      day: el.getAttribute('data-day'),
      count: el.getAttribute('data-count'),
    })),
  );
}

/** Opens `/reports` with no range, the default 30 days, and requires HTTP 200. */
async function openReports(page: Page): Promise<void> {
  const response = await page.goto('/reports');
  expect(response?.status(), 'GET /reports').toBe(200);
}

/**
 * Requires the server's today, which prefills the default range's To field, to equal the test's
 * own UTC today, so a clock mismatch fails here rather than as confusing counts later.
 */
async function expectServerToday(page: Page, today: IsoDate): Promise<void> {
  await expect(
    completionsForm(page).getByLabel('To', { exact: true }),
    'server and test disagree about today (UTC); did the test cross midnight UTC?',
  ).toHaveValue(today);
}

/** Requires each of the six summary counts to read exactly its expected number. */
async function expectSummary(
  page: Page,
  counts: Readonly<Record<SummaryTestId, number>>,
): Promise<void> {
  for (const id of SUMMARY_TEST_IDS) {
    await expect(page.getByTestId(id), `summary count ${id}`).toHaveText(String(counts[id]));
  }
}

/**
 * Enters `from` and `to` in the completions form, clicks "Show" and waits until the resulting
 * page has loaded.
 *
 * @returns The HTTP status of the `GET /reports` navigation the form submitted.
 */
async function showCompletions(page: Page, from: IsoDate, to: IsoDate): Promise<number> {
  const form = completionsForm(page);
  // `fill` sets a `type="date"` control from its `YYYY-MM-DD` value.
  await form.getByLabel('From', { exact: true }).fill(from);
  await form.getByLabel('To', { exact: true }).fill(to);
  // Registered before the click, so the response cannot be missed.
  const responsePromise = page.waitForResponse(
    (r) =>
      r.request().isNavigationRequest() &&
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === '/reports',
  );
  await form.getByRole('button', { name: 'Show', exact: true }).click();
  const response = await responsePromise;
  await page.waitForURL(
    (u) =>
      u.pathname === '/reports' &&
      u.searchParams.get('from') === from &&
      u.searchParams.get('to') === to,
  );
  return response.status();
}

/**
 * Submits From = today and To = yesterday and requires the rejected-range page: 422, the range
 * message, no table and no chart (an invalid range displays no data), the summary still shown,
 * and both dates kept as entered.
 */
async function expectStartAfterEndRejected(page: Page, today: IsoDate): Promise<void> {
  const yesterday = addDays(today, -1);
  const status = await showCompletions(page, today, yesterday);
  expect(status, 'GET /reports with From after To').toBe(422);
  await expect(page.getByRole('alert')).toHaveText(START_AFTER_END_MESSAGE);
  await expect(page.locator('#completions-table')).toHaveCount(0);
  await expect(page.locator('#completions-chart')).toHaveCount(0);
  await expect(page.getByText(NO_COMPLETIONS_MESSAGE, { exact: true })).toHaveCount(0);
  for (const id of SUMMARY_TEST_IDS) {
    await expect(page.getByTestId(id), `summary count ${id}`).toBeVisible();
  }
  const form = completionsForm(page);
  await expect(form.getByLabel('From', { exact: true })).toHaveValue(today);
  await expect(form.getByLabel('To', { exact: true })).toHaveValue(yesterday);
}

/** Clicks "Download CSV" in the export form and returns the download it starts. */
async function downloadCsv(page: Page): Promise<Download> {
  // Registered before the click, so the download event cannot be missed.
  const downloadPromise = page.waitForEvent('download');
  await exportForm(page).getByRole('button', { name: 'Download CSV', exact: true }).click();
  return downloadPromise;
}

/**
 * Reads a finished download's bytes. `download.path()` resolves once the whole file has been
 * received and rejects for a failed or cancelled download, so it never yields a partial file.
 */
async function readDownload(download: Download): Promise<Buffer> {
  return readFile(await download.path());
}

/**
 * The export record a stored task must produce: text exactly as stored, the due date as
 * `YYYY-MM-DD`, both times as ISO 8601 UTC with milliseconds, and empty fields for nulls.
 */
function expectedCsvRecord(task: StoredTask): string[] {
  return [
    String(task.id),
    task.title,
    task.description,
    task.status,
    task.priority,
    task.dueDate ?? '',
    task.createdAt.toISOString(),
    task.completedAt === null ? '' : task.completedAt.toISOString(),
  ];
}

test.describe('reports page', () => {
  test('a new user sees a zero summary and an all-zero completions table', async ({ page }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    await openReports(page);
    await expectServerToday(page, today);

    await expectSummary(page, ZERO_SUMMARY);
    await expect(page.getByText(NO_COMPLETIONS_MESSAGE, { exact: true })).toBeVisible();
    await expect(completionRows(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    expect(await dayCountAttributes(completionRows(page))).toEqual(
      defaultRangeDays(today).map((day) => ({ day, count: '0' })),
    );
    await expect(page.getByRole('alert')).toHaveCount(0);

    const exportControls = exportForm(page);
    await expect(exportControls.getByLabel('From', { exact: true })).toHaveValue(
      addDays(today, -(DEFAULT_RANGE_DAYS - 1)),
    );
    await expect(exportControls.getByLabel('To', { exact: true })).toHaveValue(today);
  });

  test('the summary counts open tasks by status and priority, and overdue ones', async ({
    page,
  }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    const yesterday = addDays(today, -1);
    await createTask(page, {
      title: 'Open high due yesterday',
      status: 'To do',
      priority: 'High',
      dueDate: yesterday,
    });
    // A task due today is not overdue.
    await createTask(page, {
      title: 'In progress low due today',
      status: 'In progress',
      priority: 'Low',
      dueDate: today,
    });
    // Done tasks are never counted in the summary, a past due date notwithstanding.
    await createTask(page, {
      title: 'Done medium due yesterday',
      status: 'Done',
      priority: 'Medium',
      dueDate: yesterday,
    });

    await openReports(page);
    await expectServerToday(page, today);
    await expectSummary(page, {
      'open-todo': 1,
      'open-in-progress': 1,
      'open-low': 1,
      'open-medium': 0,
      'open-high': 1,
      overdue: 1,
    });
  });

  test('the chart draws one bar per table row with the same day and count', async ({ page }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    await createTask(page, { title: 'Finished today', status: 'Done' });

    await openReports(page);
    await expectServerToday(page, today);
    // The script removes `hidden` only after it has appended every bar.
    await expect(page.locator('#completions-chart')).toBeVisible();
    await expect(completionRows(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    await expect(chartBars(page)).toHaveCount(await completionRows(page).count());

    const rowData = await dayCountAttributes(completionRows(page));
    expect(rowData).toEqual(
      defaultRangeDays(today).map((day) => ({ day, count: day === today ? '1' : '0' })),
    );
    expect(await dayCountAttributes(chartBars(page))).toEqual(rowData);
    await expect(
      page.locator(`#completions-table tbody tr[data-day="${today}"]`),
    ).toHaveAttribute('data-count', '1');
    await expect(page.getByText(NO_COMPLETIONS_MESSAGE, { exact: true })).toHaveCount(0);

    // A one-day range draws exactly one row and one bar.
    expect(await showCompletions(page, today, today), 'GET /reports for one day').toBe(200);
    await expect(page.locator('#completions-chart')).toBeVisible();
    await expect(completionRows(page)).toHaveCount(1);
    await expect(chartBars(page)).toHaveCount(1);
    const oneDay = await dayCountAttributes(completionRows(page));
    expect(oneDay).toEqual([{ day: today, count: '1' }]);
    expect(await dayCountAttributes(chartBars(page))).toEqual(oneDay);
  });

  test('a start date after the end date shows the message and no data', async ({ page }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    await openReports(page);
    await expectServerToday(page, today);
    await expectStartAfterEndRejected(page, today);
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('the chart stays hidden and the table alone is the report', async ({ page }) => {
      await signUpAndLogIn(page);
      const today = todayUtc(new Date());
      await createTask(page, { title: 'Finished without scripts', status: 'Done' });

      await openReports(page);
      await expectServerToday(page, today);
      const figure = page.locator('#completions-chart');
      await expect(figure).toBeHidden();
      await expect(figure).toHaveAttribute('hidden', '');
      await expect(chartBars(page)).toHaveCount(0);
      await expect(page.locator('#completions-table')).toBeVisible();
      await expect(completionRows(page)).toHaveCount(DEFAULT_RANGE_DAYS);
      await expect(
        page.locator(`#completions-table tbody tr[data-day="${today}"]`),
      ).toHaveAttribute('data-count', '1');
      await expect(page.getByText(NO_COMPLETIONS_MESSAGE, { exact: true })).toHaveCount(0);
      // The only task is Done, so every open count is zero.
      await expectSummary(page, ZERO_SUMMARY);
    });

    test('range validation works through the plain GET form', async ({ page }) => {
      await signUpAndLogIn(page);
      const today = todayUtc(new Date());
      await openReports(page);
      await expectServerToday(page, today);
      await expectStartAfterEndRejected(page, today);
    });
  });
});

test.describe('CSV export', () => {
  test('the downloaded file matches the stored tasks field by field', async ({ page }) => {
    const { email } = await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    const quotedTitle = 'Comma, "quoted" title';
    // Created now, so all three fall inside the export form's default range.
    await createTask(page, {
      title: quotedTitle,
      description: 'line one\nline two',
      status: 'Done',
    });
    await createTask(page, {
      title: 'Plain dated task',
      priority: 'High',
      dueDate: addDays(today, 7),
    });
    await createTask(page, { title: 'Bare task' });

    await openReports(page);
    await expectServerToday(page, today);
    const controls = exportForm(page);
    const from = addDays(today, -(DEFAULT_RANGE_DAYS - 1));
    await expect(controls.getByLabel('From', { exact: true })).toHaveValue(from);
    await expect(controls.getByLabel('To', { exact: true })).toHaveValue(today);
    // '' is the "All" option.
    await expect(controls.getByLabel('Status', { exact: true })).toHaveValue('');

    const download = await downloadCsv(page);
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/^tasks-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(filename).toBe(`tasks-${from}-to-${today}.csv`);

    const bytes = await readDownload(download);
    expect([...bytes.subarray(0, 3)], 'UTF-8 byte-order mark').toEqual([0xef, 0xbb, 0xbf]);
    const { bom, records } = parseCsv(bytes);
    expect(bom).toBe(true);
    expect(records[0]).toEqual(EXPECTED_CSV_HEADER);

    // Compared with the database, not the typed text: a textarea submits line breaks as CRLF.
    const stored = await userTasks(email);
    expect(stored).toHaveLength(3);
    expect(records.slice(1)).toEqual(stored.map(expectedCsvRecord));

    const quoted = stored.find((t) => t.title === quotedTitle);
    if (quoted === undefined) {
      throw new Error('the task with the comma and quotes in its title was not stored');
    }
    expect(quoted.description).toBe('line one\r\nline two');
    expect(quoted.completedAt).not.toBeNull();
    const quotedRecord = records.find((r) => r[0] === String(quoted.id));
    expect(quotedRecord?.[1]).toBe(quotedTitle);
    expect(quotedRecord?.[2]).toBe('line one\r\nline two');
    // RFC 4180 on the wire: both fields quoted, the embedded quotes doubled, the CRLF kept.
    expect(bytes.toString('utf8')).toContain(
      '"Comma, ""quoted"" title","line one\r\nline two"',
    );

    // A status filter narrows the same range to the Done task alone.
    await controls.getByLabel('Status', { exact: true }).selectOption('Done');
    const doneDownload = await downloadCsv(page);
    expect(doneDownload.suggestedFilename()).toBe(filename);
    const doneOnly = parseCsv(await readDownload(doneDownload));
    expect(doneOnly.bom).toBe(true);
    expect(doneOnly.records).toEqual([[...EXPECTED_CSV_HEADER], expectedCsvRecord(quoted)]);
  });
});

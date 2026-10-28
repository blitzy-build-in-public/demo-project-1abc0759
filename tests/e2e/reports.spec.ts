/**
 * End-to-end checks of the reports page and the CSV export in Chromium: the zero summary and the
 * empty completions table, summary counts after tasks are created through the browser, the
 * completions chart drawn from (and identical to) the table, the table-only fallback without
 * JavaScript, range validation, and the downloaded CSV compared field by field with the database.
 *
 * The completions table is checked as the user reads it, through the visible text of each row's
 * Date and Completed cells, and through the `data-day` and `data-count` attributes the chart
 * copies. The chart is checked through its bars' rendered sizes: zero height for a zero count, a
 * positive one for a positive count, and heights in proportion to the counts. Only ratios are
 * compared, so the checks hold whatever internal dimensions the chart script draws in.
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

/**
 * The text one completions-table row shows the user: its Date row header and its Completed cell,
 * each `null` when the row lacks that cell.
 */
interface DayCountCells {
  day: string | null;
  count: string | null;
}

/** A completions row as the page must show it, and as its `data-day` and `data-count` carry it. */
interface ExpectedRow {
  day: IsoDate;
  count: string;
}

/** A chart bar's `data-day` and `data-count`, with the size of its rendered box in CSS pixels. */
interface BarGeometry extends DayCountAttributes {
  width: number;
  height: number;
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

/**
 * The rows a completions range must show: each of `days` in order, with its count from `counts`
 * and 0 for every day `counts` omits.
 */
function expectedRows(
  days: readonly IsoDate[],
  counts: ReadonlyMap<IsoDate, number> = new Map(),
): ExpectedRow[] {
  return days.map((day) => ({ day, count: String(counts.get(day) ?? 0) }));
}

/**
 * Reads `data-day` and `data-count` from every matched element, in document order. These are the
 * metadata the chart copies, not what the table shows: {@link visibleCompletionCells} reads that.
 */
function dayCountAttributes(locator: Locator): Promise<DayCountAttributes[]> {
  return locator.evaluateAll((elements) =>
    elements.map((el) => ({
      day: el.getAttribute('data-day'),
      count: el.getAttribute('data-count'),
    })),
  );
}

/**
 * Reads, row by row in document order, the rendered text (`innerText`) of each completions-table
 * row's `th[scope="row"]` and its `td`, paired within the row. A missing cell reads as `null`, so
 * a row that lost its day or count fails its comparison, whatever its attributes still say.
 */
function visibleCompletionCells(page: Page): Promise<DayCountCells[]> {
  return completionRows(page).evaluateAll((rows) =>
    rows.map((row) => {
      const header = row.querySelector('th[scope="row"]');
      const cell = row.querySelector('td');
      return {
        day: header instanceof HTMLElement ? header.innerText : null,
        count: cell instanceof HTMLElement ? cell.innerText : null,
      };
    }),
  );
}

/**
 * Reads, in document order, each chart bar's `data-day` and `data-count` with the width and height
 * of its rendered box (`getBoundingClientRect`: CSS pixels, after the SVG's viewBox scaling).
 */
function chartBarGeometry(page: Page): Promise<BarGeometry[]> {
  return chartBars(page).evaluateAll((bars) =>
    bars.map((bar) => {
      const { width, height } = bar.getBoundingClientRect();
      return {
        day: bar.getAttribute('data-day'),
        count: bar.getAttribute('data-count'),
        width,
        height,
      };
    }),
  );
}

/**
 * Requires the chart's bars, in order, to be drawn to scale with `expected`: every bar has a
 * finite, positive width; a zero count draws a zero-height bar and a positive count a finite,
 * positive height; each height relative to the tallest bar's equals its count relative to the
 * largest count, so the largest count draws the tallest bar. Only these ratios are compared, never
 * the chart script's internal dimensions, so the check holds however CSS scales the chart.
 */
async function expectBarsToScale(page: Page, expected: readonly ExpectedRow[]): Promise<void> {
  const bars = await chartBarGeometry(page);
  expect(
    bars.map(({ day, count }) => ({ day, count })),
    'days and counts of the measured bars',
  ).toEqual(expected);
  const maxCount = Math.max(0, ...expected.map((row) => Number(row.count)));
  const maxHeight = Math.max(0, ...bars.map((bar) => bar.height));
  for (const bar of bars) {
    // `bar.count` equals its expected count, as required above.
    const count = Number(bar.count);
    const label = `bar of ${bar.day} (count ${count})`;
    expect(Number.isFinite(bar.width), `${label}: finite width, got ${bar.width}`).toBe(true);
    expect(bar.width, `${label}: width`).toBeGreaterThan(0);
    if (count === 0) {
      expect(bar.height, `${label}: height`).toBe(0);
      continue;
    }
    expect(Number.isFinite(bar.height), `${label}: finite height, got ${bar.height}`).toBe(true);
    expect(bar.height, `${label}: height`).toBeGreaterThan(0);
    expect(bar.height / maxHeight, `${label}: height relative to the tallest bar`).toBeCloseTo(
      count / maxCount,
      2,
    );
  }
  if (maxCount > 0) {
    const tallest = bars.find((bar) => bar.height === maxHeight);
    expect(tallest?.count, 'count of the tallest bar').toBe(String(maxCount));
  }
}

/**
 * Returns the `/reports` page `body` with the zero completions row of `day` set to `count`, in
 * both its `data-count` and its visible Completed cell, as a server holding that many completions
 * would render it.
 *
 * @throws Error when `body` has no zero row for `day`, so a markup change fails the test rather
 *   than leaving the page unrewritten.
 */
function withRowCount(body: string, day: IsoDate, count: number): string {
  const zeroRow = new RegExp(
    `(<tr data-day="${day}" data-count=")0(">\\s*<th scope="row">${day}</th><td>)0(</td>)`,
  );
  const rewritten = body.replace(
    zeroRow,
    (_row: string, start: string, middle: string, end: string) =>
      `${start}${count}${middle}${count}${end}`,
  );
  if (rewritten === body) {
    throw new Error(`the reports page lacks a zero completions row for ${day} to rewrite`);
  }
  return rewritten;
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
    const allZero = expectedRows(defaultRangeDays(today));
    await expect(page.locator('#completions-table')).toBeVisible();
    expect(await visibleCompletionCells(page), 'visible Date and Completed cells').toEqual(allZero);
    expect(await dayCountAttributes(completionRows(page))).toEqual(allZero);
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
    // The chart is an addition: the table stays beside it as the report.
    await expect(page.locator('#completions-table')).toBeVisible();
    await expect(completionRows(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    await expect(chartBars(page)).toHaveCount(await completionRows(page).count());

    const expected = expectedRows(defaultRangeDays(today), new Map([[today, 1]]));
    expect(await visibleCompletionCells(page), 'visible Date and Completed cells').toEqual(
      expected,
    );
    const rowData = await dayCountAttributes(completionRows(page));
    expect(rowData).toEqual(expected);
    expect(await dayCountAttributes(chartBars(page))).toEqual(rowData);
    await expect(
      page.locator(`#completions-table tbody tr[data-day="${today}"]`),
    ).toHaveAttribute('data-count', '1');
    // Today's completion draws a visible bar; the 29 empty days draw none.
    await expectBarsToScale(page, expected);
    await expect(page.getByText(NO_COMPLETIONS_MESSAGE, { exact: true })).toHaveCount(0);

    // A one-day range draws exactly one row and one bar.
    expect(await showCompletions(page, today, today), 'GET /reports for one day').toBe(200);
    await expect(page.locator('#completions-chart')).toBeVisible();
    await expect(completionRows(page)).toHaveCount(1);
    await expect(chartBars(page)).toHaveCount(1);
    const oneDayExpected = expectedRows([today], new Map([[today, 1]]));
    expect(await visibleCompletionCells(page), 'visible Date and Completed cells').toEqual(
      oneDayExpected,
    );
    const oneDay = await dayCountAttributes(completionRows(page));
    expect(oneDay).toEqual(oneDayExpected);
    expect(await dayCountAttributes(chartBars(page))).toEqual(oneDay);
    await expectBarsToScale(page, oneDayExpected);
  });

  test('the chart scales its bars to distinct positive counts', async ({ page }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    const days = defaultRangeDays(today);
    // Distinct counts, the largest in the middle of the range, so neither end bar is the tallest.
    const counts = new Map([
      [addDays(today, -24), 2],
      [addDays(today, -12), 5],
      [today, 1],
    ]);
    const expected = expectedRows(days, counts);
    // Distinct positive counts need completions on distinct past days, but a task completed
    // through the browser is completed today, and these specs reach the server only through its
    // pages: support.ts writes nothing to the database. The server's own page is therefore
    // rewritten on the way to the browser, giving three zero rows those counts in both their
    // `data-count` and their visible cell, as a server holding those completions would render
    // them. Only GET is rewritten, and the chart script then runs on the rewritten table.
    await page.route('**/reports', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      const rewritten = [...counts].reduce(
        (markup, [day, count]) => withRowCount(markup, day, count),
        body,
      );
      // The fetched Content-Length no longer fits the body; without it the new length is sent.
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(([name]) => name !== 'content-length'),
      );
      await route.fulfill({ response, body: rewritten, headers });
    });

    await openReports(page);
    await expectServerToday(page, today);
    await expect(page.locator('#completions-chart')).toBeVisible();
    await expect(page.locator('#completions-table')).toBeVisible();
    await expect(completionRows(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    await expect(chartBars(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    expect(await visibleCompletionCells(page), 'visible Date and Completed cells').toEqual(
      expected,
    );
    const rowData = await dayCountAttributes(completionRows(page));
    expect(rowData).toEqual(expected);
    expect(await dayCountAttributes(chartBars(page))).toEqual(rowData);
    await expectBarsToScale(page, expected);
  });

  test('the chart labels an all-zero range once and every day answers the pointer', async ({
    page,
  }) => {
    await signUpAndLogIn(page);
    const today = todayUtc(new Date());
    await openReports(page);
    await expectServerToday(page, today);
    await expect(page.locator('#completions-chart')).toBeVisible();
    // The scale's floor makes the plot's top stand for 1, so an all-zero range labels only the
    // baseline, whose 0 is then the maximum.
    const valueLabels = page.locator('.chart-y-labels .chart-label');
    await expect(valueLabels).toHaveCount(1);
    await expect(valueLabels).toHaveText('0');

    await createTask(page, { title: 'Finished for the tooltips', status: 'Done' });
    await openReports(page);
    await expectServerToday(page, today);
    await expect(page.locator('#completions-chart')).toBeVisible();
    await expect(chartBars(page)).toHaveCount(DEFAULT_RANGE_DAYS);
    // `elementFromPoint` sees only the viewport.
    await page.locator('#completions-chart svg').scrollIntoViewIfNeeded();
    // Each bar's horizontal centre, halfway up the plot: a zero-count bar draws nothing there, so
    // whatever answers the pointer must still carry that day's tooltip as its own <title>.
    const tooltips = await chartBars(page).evaluateAll((bars) =>
      bars.map((bar) => {
        const plot = bar.closest('svg');
        if (plot === null) {
          return null;
        }
        const barBox = bar.getBoundingClientRect();
        const plotBox = plot.getBoundingClientRect();
        const hit = document.elementFromPoint(
          barBox.left + barBox.width / 2,
          plotBox.top + plotBox.height / 2,
        );
        return hit?.querySelector(':scope > title')?.textContent ?? null;
      }),
    );
    expect(tooltips, 'tooltip under each bar, halfway up the plot').toEqual(
      expectedRows(defaultRangeDays(today), new Map([[today, 1]])).map(
        ({ day, count }) => `${day}: ${count}`,
      ),
    );
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
      expect(await visibleCompletionCells(page), 'visible Date and Completed cells').toEqual(
        expectedRows(defaultRangeDays(today), new Map([[today, 1]])),
      );
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

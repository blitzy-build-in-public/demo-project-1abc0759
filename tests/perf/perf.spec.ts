/**
 * Performance check with 10,000 tasks for one user (plan 0.9.3, success criterion SC12).
 *
 * Seeds a real perf user through `./seed`, logs in through the browser form, then times the task
 * list (unfiltered and filtered), the reports page (default and 366-day ranges) and the 366-day
 * CSV export. Each target gets one warm-up and five measured loads, and readiness is asserted after
 * every load, warm-up included. Every measured run must stay under 2,000 ms. The min, median and
 * max per target are printed and written to `test-results/perf.json` whether the check passes or
 * not.
 *
 * Run it with `npm run test:perf` and `PERF_BASE_URL` pointing at the production-mode application
 * container, whose database `DATABASE_URL` names. That run has no web server or global setup, and
 * this spec never touches the test-database helpers: it targets the application database, so it
 * never truncates and touches only the rows of the user it creates and then deletes.
 *
 * The printed timing summary and `perf.json` omit the perf user's email, password and session
 * token, and the database URL.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS } from '../../src/reports/date-range';
import { addDays, todayUtc, type IsoDate } from '../../src/shared/dates';
import { parseCsv } from '../helpers/csv-parse';
import { deletePerfUser, PERF_TASK_COUNT, seedPerfUser, type PerfUser } from './seed';

/** Every measured run must finish strictly below this many milliseconds. */
const THRESHOLD_MS = 2000;

/** Untimed loads per target before measuring; their readiness is still asserted. */
const WARMUP_RUNS = 1;

/** Timed loads per target. */
const MEASURED_RUNS = 5;

/** Where the results are written; Playwright empties `test-results/` only at the start of a run. */
const REPORT_PATH = path.resolve(__dirname, '..', '..', 'test-results', 'perf.json');

/**
 * The export's header row, kept as a literal rather than imported from `src/reports/csv.ts` so
 * that the check stays independent of the writer it verifies.
 */
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

/** How long the post-login landing on the full task list may take; it is not a measured load. */
const LOGIN_LANDING_TIMEOUT_MS = 30_000;

/** One timed target: what it is called in the output, the URL it loads, and how one run goes. */
interface Target {
  name: string;
  url: string;
  /** Performs one load, asserts its readiness, and returns the load's time in milliseconds. */
  run(page: Page): Promise<number>;
}

/**
 * A target's measured runs as taken, collected run by run. These raw durations are what the
 * threshold is applied to; only {@link TargetResult} holds the display form.
 */
interface MeasuredTarget {
  name: string;
  url: string;
  /** Each measured run's duration in milliseconds, unrounded, in run order. */
  runs: number[];
}

/**
 * A target's measured runs and their statistics, as printed and written to `perf.json`. Every
 * duration is in display form ({@link displayMs}).
 */
interface TargetResult {
  name: string;
  url: string;
  /** Each measured run in milliseconds, in display form, in run order. */
  runs: number[];
  /** The fastest run, or `null` when no run was measured. */
  min: number | null;
  /** The median of the raw runs, put in display form afterwards; `null` when none was measured. */
  median: number | null;
  /** The slowest run, or `null` when no run was measured. */
  max: number | null;
}

/**
 * Puts a duration in display form for the output: truncated (rounded down) to 0.1 ms. The verdict
 * compares the raw duration with {@link THRESHOLD_MS}; truncation keeps the shown value consistent
 * with it, so a shown value is at or above 2000.0 exactly when the run failed. Rounding to the
 * nearest 0.1 ms would show 2000.0 for a passing 1999.96 ms run.
 */
function displayMs(ms: number): number {
  return Math.floor(ms * 10) / 10;
}

/**
 * Returns the output form of `measured`: its runs and their `min`, `median` and `max`, each
 * statistic `null` when there are no runs. The statistics are computed from the raw runs and put
 * in display form last. The median is the middle sorted value, or the mean of the two middle
 * values.
 */
function withStats(measured: MeasuredTarget): TargetResult {
  const { name, url } = measured;
  const runs = measured.runs.map(displayMs);
  const sorted = [...measured.runs].sort((a, b) => a - b);
  const count = sorted.length;
  const first = sorted[0];
  const last = sorted[count - 1];
  if (first === undefined || last === undefined) {
    return { name, url, runs, min: null, median: null, max: null };
  }
  const upper = sorted[Math.floor(count / 2)] ?? last;
  const lower = sorted[Math.floor((count - 1) / 2)] ?? first;
  return {
    name,
    url,
    runs,
    min: displayMs(first),
    median: displayMs((lower + upper) / 2),
    max: displayMs(last),
  };
}

/**
 * Loads `url` as a fresh navigation and returns its page-load milestone: `loadEventEnd` of the
 * Navigation Timing entry, which is relative to navigation start (`startTime` 0).
 *
 * The milestone covers server time, transfer, parsing of the complete HTML (every table row is in
 * the DOM), the stylesheet, and the deferred scripts with their `DOMContentLoaded` handlers, so on
 * `/reports` the chart's SVG exists before `load`. It does not cover layout or paint, and the
 * check claims neither.
 *
 * @throws Error when the final response is not HTTP 200 or no navigation entry exists.
 */
async function measurePage(page: Page, url: string): Promise<number> {
  const response = await page.goto(url);
  if (response === null || response.status() !== 200) {
    throw new Error(`${url} answered HTTP ${response === null ? 'none' : response.status()}`);
  }
  // `loadEventEnd` stays 0 while the load handlers run, so `goto` resolving is not enough.
  await page.waitForFunction(() => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry !== undefined && entry.loadEventEnd > 0;
  });
  return page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (entry === undefined) {
      throw new Error('No navigation timing entry');
    }
    return entry.loadEventEnd;
  });
}

/** Asserts that the task list holds exactly `expected` rows. */
async function expectTaskRows(page: Page, expected: number): Promise<void> {
  await expect(page.locator('tbody tr')).toHaveCount(expected);
}

/**
 * Asserts that the completions table holds one row per day of the range and that the chart has
 * been built from it: the figure is no longer hidden and holds one bar per row.
 */
async function expectReportReady(page: Page, expectedDays: number): Promise<void> {
  await expect(page.locator('#completions-table tbody tr[data-day][data-count]')).toHaveCount(
    expectedDays,
  );
  const chart = page.locator('#completions-chart');
  await expect(chart).not.toHaveAttribute('hidden');
  await expect(chart.locator('rect')).toHaveCount(expectedDays);
}

/**
 * Times one CSV export through the export form on `/reports`: from the click on "Download CSV"
 * until `download.path()` resolves, which happens once the whole file has been received. The
 * `/reports` load before it is untimed.
 *
 * Readiness, checked after the timing: the suggested file name names the range, and the file
 * starts with the byte-order mark, has the exact header and holds one record per seeded task.
 *
 * @returns The export's wall-clock time in milliseconds.
 */
async function measureExport(page: Page, from: IsoDate, to: IsoDate): Promise<number> {
  const response = await page.goto('/reports');
  if (response === null || response.status() !== 200) {
    throw new Error(`/reports answered HTTP ${response === null ? 'none' : response.status()}`);
  }
  // The completions form has From and To fields as well, so every locator is scoped to this form.
  const form = page.locator('form[action="/reports/export"]');
  await form.getByLabel('From', { exact: true }).fill(from);
  await form.getByLabel('To', { exact: true }).fill(to);
  await form.getByLabel('Status', { exact: true }).selectOption({ label: 'All' });

  // Registered before the click, so the download event cannot be missed.
  const downloadPromise = page.waitForEvent('download');
  const started = performance.now();
  await form.getByRole('button', { name: 'Download CSV' }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const elapsed = performance.now() - started;

  expect(download.suggestedFilename()).toBe(`tasks-${from}-to-${to}.csv`);
  const { bom, records } = parseCsv(readFileSync(filePath));
  expect(bom).toBe(true);
  expect(records[0]).toEqual([...EXPECTED_CSV_HEADER]);
  // The header plus one record per task proves the 366-day range covers every seeded task.
  expect(records.length).toBe(PERF_TASK_COUNT + 1);
  return elapsed;
}

/** Writes the run's settings and results to {@link REPORT_PATH} as indented JSON. */
function writeReport(baseUrl: string, results: readonly TargetResult[]): void {
  const report = {
    timestamp: new Date().toISOString(),
    baseUrl,
    taskCount: PERF_TASK_COUNT,
    thresholdMs: THRESHOLD_MS,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    results,
  };
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}

/** Formats a statistic for the summary table; `-` stands for a target with no measured run. */
function formatMs(ms: number | null): string {
  return ms === null ? '-' : ms.toFixed(1);
}

/** Prints min, median and max per target as a fixed-width table, then the results file's path. */
function printSummary(results: readonly TargetResult[]): void {
  const nameWidth = Math.max('target'.length, ...results.map((r) => r.name.length));
  const numberWidth = 10;
  const line = (cells: readonly [string, string, string, string, string]): string => {
    const [name, min, median, max, runs] = cells;
    return [
      name.padEnd(nameWidth),
      min.padStart(numberWidth),
      median.padStart(numberWidth),
      max.padStart(numberWidth),
      runs.padStart(6),
    ].join('  ');
  };
  const lines = [
    `SC12 performance: ${PERF_TASK_COUNT} tasks, every run must be under ${THRESHOLD_MS} ms`,
    line(['target', 'min ms', 'median ms', 'max ms', 'runs']),
    ...results.map((r) =>
      line([r.name, formatMs(r.min), formatMs(r.median), formatMs(r.max), String(r.runs.length)]),
    ),
    `Results written to ${REPORT_PATH}`,
  ];
  console.log(lines.join('\n'));
}

test.describe('SC12 performance with 10,000 tasks', () => {
  test.describe.configure({ mode: 'serial' });

  let baseUrl: string | undefined;
  let user: PerfUser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let today: IsoDate;
  let from366: IsoDate;

  test.beforeAll(async ({ browser }, testInfo) => {
    const resolvedBaseUrl = testInfo.project.use.baseURL ?? process.env.PERF_BASE_URL;
    if (resolvedBaseUrl === undefined || resolvedBaseUrl === '') {
      throw new Error(
        'PERF_BASE_URL must be set, for example http://localhost:3000 (the compose app container)',
      );
    }
    baseUrl = resolvedBaseUrl;
    // The URL carries the database password, so it is never printed or put in a message.
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'DATABASE_URL must point at the database the app at PERF_BASE_URL uses ' +
          '(compose: tasktracker)',
      );
    }

    user = await seedPerfUser(resolvedBaseUrl, databaseUrl);
    // Fixed once, right after seeding: every seeded created_at falls within the 365 days before
    // this moment, so the 366-day range covers every task even if the run crosses UTC midnight.
    today = todayUtc(new Date());
    from366 = addDays(today, -(MAX_RANGE_DAYS - 1));

    // JavaScript stays enabled so the chart is built and its bars can be counted.
    context = await browser.newContext({ baseURL: resolvedBaseUrl });
    page = await context.newPage();

    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    // The landing page is the full 10,000-row list; it is not a measured load, so a loaded host
    // gets more than the default assertion timeout before the login counts as failed.
    await expect(page).toHaveURL(/\/tasks$/, { timeout: LOGIN_LANDING_TIMEOUT_MS });
    await page.waitForLoadState('load');
  });

  test.afterAll(async () => {
    try {
      if (context !== undefined) {
        await context.close();
      }
    } finally {
      // Attempts the user cleanup even if closing the browser context fails. Deleting the user
      // removes its sessions and tasks by cascade, and its failed attempts through the
      // login-attempts trigger.
      if (user !== undefined) {
        await deletePerfUser(user);
      }
    }
  });

  test('SC12: task list and reports load in under 2 seconds with 10,000 tasks', async () => {
    if (page === undefined || user === undefined || baseUrl === undefined) {
      throw new Error('The perf user was not seeded and logged in by beforeAll');
    }
    const activePage = page;
    const filteredCount = user.filteredCount;
    const reportsRangeUrl = `/reports?from=${from366}&to=${today}`;

    const targets: readonly Target[] = [
      {
        name: 'tasks-unfiltered',
        url: '/tasks',
        async run(p: Page): Promise<number> {
          const ms = await measurePage(p, '/tasks');
          await expectTaskRows(p, PERF_TASK_COUNT);
          return ms;
        },
      },
      {
        name: 'tasks-to-do-high',
        url: '/tasks?status=To%20do&priority=High',
        async run(p: Page): Promise<number> {
          const ms = await measurePage(p, '/tasks?status=To%20do&priority=High');
          await expectTaskRows(p, filteredCount);
          return ms;
        },
      },
      {
        name: 'reports-default',
        url: '/reports',
        async run(p: Page): Promise<number> {
          const ms = await measurePage(p, '/reports');
          await expectReportReady(p, DEFAULT_RANGE_DAYS);
          return ms;
        },
      },
      {
        name: 'reports-366-days',
        url: reportsRangeUrl,
        async run(p: Page): Promise<number> {
          const ms = await measurePage(p, reportsRangeUrl);
          await expectReportReady(p, MAX_RANGE_DAYS);
          return ms;
        },
      },
      {
        name: 'export-366-days',
        url: `/reports/export?from=${from366}&to=${today}&status=`,
        run: (p: Page): Promise<number> => measureExport(p, from366, today),
      },
    ];

    const results: MeasuredTarget[] = [];
    try {
      for (const target of targets) {
        // Recorded before measuring, and filled run by run, so a readiness failure keeps the
        // runs measured so far in the output.
        const result: MeasuredTarget = { name: target.name, url: target.url, runs: [] };
        results.push(result);
        await test.step(target.name, async () => {
          for (let i = 0; i < WARMUP_RUNS; i += 1) {
            await target.run(activePage);
          }
          for (let i = 0; i < MEASURED_RUNS; i += 1) {
            result.runs.push(await target.run(activePage));
          }
        });
      }
    } finally {
      const finished = results.map(withStats);
      writeReport(baseUrl, finished);
      printSummary(finished);
    }

    // The verdict compares raw durations, so rounding cannot move a run across the threshold;
    // only the message shows them in display form.
    const offenders = results.flatMap((r) =>
      r.runs.flatMap((ms, k) =>
        ms >= THRESHOLD_MS ? [`${r.name} run ${k + 1}: ${displayMs(ms)} ms`] : [],
      ),
    );
    expect(offenders, `Runs at or above ${THRESHOLD_MS} ms:\n${offenders.join('\n')}`).toEqual([]);
  });
});

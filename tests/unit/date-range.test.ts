/**
 * Unit tests of the report date-range rules, the zero-filled completions report and the UTC date
 * helpers they rest on (pure functions, no database and no clock).
 *
 * Report ranges are inclusive at both ends and span at most 366 days. A value is absent when it is
 * `undefined` or `''`, and the default range (today − 29 to today) applies only when both are
 * absent. Years `0001` and `9999` are the limits of `IsoDate`, so ranges at either end must be
 * accepted and listed day by day without ever computing a date outside them.
 */

import { zeroFillCompletions } from '../../src/reports/completions';
import type { CompletionsReport } from '../../src/reports/completions';
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  defaultRange,
  parseDateRange,
} from '../../src/reports/date-range';
import type { DateRangeResult } from '../../src/reports/date-range';
import {
  addDays,
  eachDay,
  inclusiveDayCount,
  parseIsoDate,
  todayUtc,
} from '../../src/shared/dates';
import type { DateRange, IsoDate } from '../../src/shared/dates';
import type { DayCount } from '../../src/db/types';

/** The current UTC day passed to every range rule. */
const TODAY = '2026-10-21';

/** The default range for {@link TODAY}: the 30 days ending today, both ends included. */
const DEFAULT_FOR_TODAY: DateRange = { from: '2026-09-22', to: '2026-10-21' };

/** The shape of every `IsoDate`; a five-digit year such as `10000-01-01` fails it. */
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The raw `from` and `to` query values that `parseDateRange` receives. */
type RangeInput = Parameters<typeof parseDateRange>[0];

/** The result `parseDateRange` returns when it rejects a range with `message`. */
function rejected(message: string): DateRangeResult {
  return { ok: false, message };
}

/**
 * The days 2026-09-22 to 2026-10-21 written out month by month, independently of `eachDay`, so the
 * default-range report is checked against dates the code under test did not produce.
 */
function daysOfDefaultRange(): IsoDate[] {
  const september = Array.from({ length: 9 }, (_, i) => `2026-09-${String(22 + i)}`);
  const october = Array.from({ length: 21 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  return [...september, ...october];
}

describe('range constants', () => {
  test('a range spans at most 366 days and the default range is 30 days', () => {
    expect(MAX_RANGE_DAYS).toBe(366);
    expect(DEFAULT_RANGE_DAYS).toBe(30);
  });
});

describe('defaultRange', () => {
  test.each<{ name: string; today: IsoDate; range: DateRange }>([
    { name: 'ends today and starts 29 days earlier', today: TODAY, range: DEFAULT_FOR_TODAY },
    {
      name: 'crosses a year boundary',
      today: '2026-01-10',
      range: { from: '2025-12-12', to: '2026-01-10' },
    },
  ])('$name', ({ today, range }) => {
    expect(defaultRange(today)).toEqual(range);
    expect(inclusiveDayCount(range.from, range.to)).toBe(30);
  });
});

describe('parseDateRange', () => {
  test.each<{ name: string; input: RangeInput }>([
    { name: 'both values are absent', input: {} },
    {
      name: 'both values are empty, as an emptied GET form submits them',
      input: { from: '', to: '' },
    },
  ])('uses the default range when $name', ({ input }) => {
    expect(parseDateRange(input, TODAY)).toEqual({ ok: true, range: DEFAULT_FOR_TODAY });
  });

  test.each<{ name: string; input: RangeInput; message: string }>([
    {
      name: 'only the start date supplied',
      input: { from: '2026-10-01' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'only the end date supplied',
      input: { to: '2026-10-01' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'a start date with an empty end date',
      input: { from: '2026-10-01', to: '' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'an empty start date with an end date',
      input: { from: '', to: '2026-10-01' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'a start date in month 13',
      input: { from: '2026-13-01', to: '2026-10-21' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'a start date that is not a date',
      input: { from: 'abc', to: '2026-10-21' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'an end date that does not exist in its month',
      input: { from: '2026-10-01', to: '2026-02-30' },
      message: 'Enter valid start and end dates.',
    },
    {
      // '2026-10-32' sorts after the end date as text, so the parse check must come first.
      name: 'an unparseable start date that sorts after the end date',
      input: { from: '2026-10-32', to: '2026-10-21' },
      message: 'Enter valid start and end dates.',
    },
    {
      name: 'a start date one day after the end date',
      input: { from: '2026-10-22', to: '2026-10-21' },
      message: 'Start date must be on or before end date.',
    },
    {
      name: '367 days',
      input: { from: '2025-01-01', to: '2026-01-02' },
      message: 'Date range cannot be longer than 366 days.',
    },
    {
      name: '367 days covering the leap year 2024',
      input: { from: '2024-01-01', to: '2025-01-01' },
      message: 'Date range cannot be longer than 366 days.',
    },
  ])('rejects $name', ({ input, message }) => {
    expect(parseDateRange(input, TODAY)).toEqual(rejected(message));
  });

  test.each<{ name: string; range: DateRange; days: number }>([
    { name: '366 days', range: { from: '2025-01-01', to: '2026-01-01' }, days: 366 },
    { name: 'the leap year 2024', range: { from: '2024-01-01', to: '2024-12-31' }, days: 366 },
    { name: 'equal dates as one day', range: { from: TODAY, to: TODAY }, days: 1 },
    { name: 'future dates', range: { from: '2027-01-01', to: '2027-01-31' }, days: 31 },
    { name: 'the whole of year 0001', range: { from: '0001-01-01', to: '0001-12-31' }, days: 365 },
    { name: 'the whole of year 9999', range: { from: '9999-01-01', to: '9999-12-31' }, days: 365 },
  ])('accepts $name', ({ range, days }) => {
    expect(parseDateRange(range, TODAY)).toEqual({ ok: true, range });
    expect(inclusiveDayCount(range.from, range.to)).toBe(days);
  });
});

describe('parseIsoDate', () => {
  test.each([
    '0000-01-01',
    '10000-01-01',
    '9999-12-32',
    '2026-02-29',
    '2026-1-01',
    '',
    '2026-10-21T00:00:00Z',
  ])('rejects %p', (raw) => {
    expect(parseIsoDate(raw)).toBeNull();
  });

  test.each(['2024-02-29', '0001-01-01', '9999-12-31'])('accepts %p unchanged', (raw) => {
    expect(parseIsoDate(raw)).toBe(raw);
  });
});

describe('todayUtc', () => {
  test.each<{ at: string; day: IsoDate }>([
    { at: '2026-10-21T23:59:59.999Z', day: '2026-10-21' },
    { at: '2026-10-22T00:00:00.000Z', day: '2026-10-22' },
  ])('$at falls on the UTC day $day', ({ at, day }) => {
    expect(todayUtc(new Date(at))).toBe(day);
  });
});

describe('addDays', () => {
  test.each<{ name: string; day: IsoDate; n: number; result: IsoDate }>([
    {
      name: 'keeps years below 100 instead of mapping them to 19xx',
      day: '0001-01-01',
      n: 1,
      result: '0001-01-02',
    },
    {
      name: 'steps back across a month end in a common year',
      day: '2026-03-01',
      n: -1,
      result: '2026-02-28',
    },
  ])('$name', ({ day, n, result }) => {
    expect(addDays(day, n)).toBe(result);
  });
});

describe('eachDay', () => {
  test('lists the 31 days of December 9999 and stops at 9999-12-31', () => {
    // eachDay is synchronous, so a loop that never reached its end would block the event loop and
    // no Jest timeout could interrupt it. The exact length and last day are the guard: the days
    // are generated by index, so the day after 9999-12-31 (year 10000) is never computed.
    const days = eachDay('9999-12-01', '9999-12-31');

    expect(days).toHaveLength(31);
    expect(days.at(0)).toBe('9999-12-01');
    expect(days.at(-1)).toBe('9999-12-31');
    for (const day of days) {
      expect(day).toMatch(ISO_DATE_SHAPE);
    }
  });

  test.each<{ name: string; from: IsoDate; to: IsoDate; days: IsoDate[] }>([
    {
      name: 'the first days of year 0001',
      from: '0001-01-01',
      to: '0001-01-03',
      days: ['0001-01-01', '0001-01-02', '0001-01-03'],
    },
    {
      name: 'a leap day',
      from: '2024-02-28',
      to: '2024-03-01',
      days: ['2024-02-28', '2024-02-29', '2024-03-01'],
    },
  ])('lists every day of a range including $name', ({ from, to, days }) => {
    expect(eachDay(from, to)).toEqual(days);
  });
});

describe('zeroFillCompletions', () => {
  test.each<{ name: string; range: DateRange; rows: DayCount[]; expected: CompletionsReport }>([
    {
      name: 'fills the days around a single completion day with zeros',
      range: { from: '2026-10-19', to: '2026-10-21' },
      rows: [{ day: '2026-10-20', count: 3 }],
      expected: {
        range: { from: '2026-10-19', to: '2026-10-21' },
        days: [
          { day: '2026-10-19', count: 0 },
          { day: '2026-10-20', count: 3 },
          { day: '2026-10-21', count: 0 },
        ],
        total: 3,
      },
    },
    {
      name: 'counts completions on both the first and the last day',
      range: { from: '2026-10-19', to: '2026-10-21' },
      rows: [
        { day: '2026-10-19', count: 2 },
        { day: '2026-10-21', count: 5 },
      ],
      expected: {
        range: { from: '2026-10-19', to: '2026-10-21' },
        days: [
          { day: '2026-10-19', count: 2 },
          { day: '2026-10-20', count: 0 },
          { day: '2026-10-21', count: 5 },
        ],
        total: 7,
      },
    },
    {
      name: 'reports a one-day range as one entry',
      range: { from: TODAY, to: TODAY },
      rows: [{ day: TODAY, count: 4 }],
      expected: { range: { from: TODAY, to: TODAY }, days: [{ day: TODAY, count: 4 }], total: 4 },
    },
    {
      name: 'ignores rows outside the range, so the total matches the table',
      range: { from: '2026-10-20', to: '2026-10-21' },
      rows: [
        { day: '2026-10-19', count: 9 },
        { day: '2026-10-21', count: 1 },
        { day: '2026-10-22', count: 9 },
      ],
      expected: {
        range: { from: '2026-10-20', to: '2026-10-21' },
        days: [
          { day: '2026-10-20', count: 0 },
          { day: '2026-10-21', count: 1 },
        ],
        total: 1,
      },
    },
  ])('$name', ({ range, rows, expected }) => {
    expect(zeroFillCompletions(range, rows)).toEqual(expected);
  });

  test('lists the 30 days of the default range in order with zeros when none completed', () => {
    const expectedDays = daysOfDefaultRange();

    expect(expectedDays).toHaveLength(30);
    expect(zeroFillCompletions(defaultRange(TODAY), [])).toEqual({
      range: DEFAULT_FOR_TODAY,
      days: expectedDays.map((day) => ({ day, count: 0 })),
      total: 0,
    });
  });
});

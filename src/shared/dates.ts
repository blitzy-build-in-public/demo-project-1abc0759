/**
 * UTC date-only helpers for due dates, report ranges and "today".
 *
 * Every calculation uses UTC methods only, so results never depend on the process time zone, and
 * date-only values stay `YYYY-MM-DD` strings rather than local-time `Date` objects.
 */

/**
 * A calendar date in the form `YYYY-MM-DD`, with a four-digit year from `0001` to `9999` and a real
 * proleptic Gregorian day (the calendar PostgreSQL and `Date` both use).
 *
 * It is a plain alias rather than a branded type. Values are produced only by
 * {@link parseIsoDate}, {@link todayUtc}, {@link addDays}, {@link eachDay} and the `pg` DATE type
 * parser in `src/db/pool.ts`, so every value is also a valid PostgreSQL `date`.
 */
export type IsoDate = string;

/**
 * A date range that is inclusive at both ends, used by `src/reports` and `src/db/tasks-repo.ts`.
 *
 * The repository turns it into UTC timestamp bounds in SQL, so no JavaScript code ever computes the
 * day after `to`, which for `9999-12-31` would fall outside {@link IsoDate}.
 */
export interface DateRange {
  /** First day of the range, included. */
  from: IsoDate;
  /** Last day of the range, included. */
  to: IsoDate;
}

/** Exactly four, two and two ASCII digits; rejects signs, five-digit years, times and spaces. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1;
const MAX_YEAR = 9999;
const MS_PER_DAY = 86_400_000;

interface DateParts {
  y: number;
  m: number;
  d: number;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    return isLeapYear(y) ? 29 : 28;
  }
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function toParts(day: string): DateParts | null {
  // The static type says string, but callers pass request data, so the runtime check stays.
  if (typeof day !== 'string') {
    return null;
  }
  const match = ISO_DATE_PATTERN.exec(day);
  if (match === null) {
    return null;
  }
  const [, yearText, monthText, dayText] = match;
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    return null;
  }
  const y = Number(yearText);
  const m = Number(monthText);
  const d = Number(dayText);
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    return null;
  }
  return { y, m, d };
}

function requireParts(day: IsoDate, label: string): DateParts {
  const parts = toParts(day);
  if (parts === null) {
    // The raw value is left out of the message so that log lines carry no user data.
    throw new RangeError(`Invalid IsoDate for ${label}`);
  }
  return parts;
}

function utcMidnight(y: number, m: number, d: number): Date {
  // Date.UTC and the multi-argument Date constructor map years 0-99 to 1900-1999, so the date is
  // built with setUTCFullYear on the epoch, which also normalises day overflow such as day 0 or 32.
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t;
}

function format(t: Date): IsoDate {
  // toISOString writes years outside 0000-9999 in the extended +/-YYYYYY form, so the year is
  // checked first; an invalid Date yields NaN and fails the same check.
  const y = t.getUTCFullYear();
  if (!(y >= MIN_YEAR && y <= MAX_YEAR)) {
    throw new RangeError('Date is outside the IsoDate range (years 0001-9999)');
  }
  return t.toISOString().slice(0, 10);
}

function inclusiveCount(from: DateParts, to: DateParts): number {
  const start = utcMidnight(from.y, from.m, from.d).getTime();
  const end = utcMidnight(to.y, to.m, to.d).getTime();
  // Both instants are UTC midnights and UTC has no daylight-saving shifts, so the span is a whole
  // number of days.
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/**
 * Validates a date-only string from user input, such as a task due date or a report range endpoint.
 *
 * The value must be exactly `YYYY-MM-DD` with no surrounding whitespace, a year from `0001` to
 * `9999`, a month from `01` to `12` and a day that exists in that month, Gregorian leap years
 * included (`2024-02-29` is accepted, `2026-02-29` and `1900-02-29` are rejected). An empty value
 * is rejected; a caller for which it means absent, such as the optional due date, checks first.
 *
 * @param raw - The submitted text.
 * @returns The input unchanged, which is already canonical, or `null` when it is not a valid date.
 */
export function parseIsoDate(raw: string): IsoDate | null {
  return toParts(raw) === null ? null : raw;
}

/**
 * Returns the current calendar day in UTC.
 *
 * @param now - The current instant, taken from the injected `Clock`.
 * @returns The UTC date of `now`.
 * @throws RangeError when `now` is an invalid date or falls outside years `0001`–`9999`.
 */
export function todayUtc(now: Date): IsoDate {
  return format(now);
}

/**
 * Adds a whole number of days to a date, in UTC.
 *
 * Intended for callers whose result stays within years `0001`–`9999`, such as the default report
 * range (`addDays(today, -29)`).
 *
 * @param day - A valid {@link IsoDate}.
 * @param n - The number of days to add; negative values move backwards.
 * @returns The resulting date.
 * @throws RangeError when `day` is not a valid {@link IsoDate}, `n` is not a safe integer, or the
 *   result falls outside years `0001`–`9999`.
 */
export function addDays(day: IsoDate, n: number): IsoDate {
  const { y, m, d } = requireParts(day, 'day');
  if (!Number.isSafeInteger(n)) {
    throw new RangeError('Day offset must be a safe integer');
  }
  return format(utcMidnight(y, m, d + n));
}

/**
 * Counts the days from `from` to `to`, both included.
 *
 * Equal dates count as 1. When `from` is after `to` the result is 0 or negative, which callers such
 * as `parseDateRange` reject before applying their length limit.
 *
 * @param from - The first day, a valid {@link IsoDate}.
 * @param to - The last day, a valid {@link IsoDate}.
 * @returns `to − from + 1` in days.
 * @throws RangeError when either argument is not a valid {@link IsoDate}.
 */
export function inclusiveDayCount(from: IsoDate, to: IsoDate): number {
  return inclusiveCount(requireParts(from, 'from'), requireParts(to, 'to'));
}

/**
 * Lists every day from `from` to `to`, both included, in ascending order.
 *
 * @param from - The first day, a valid {@link IsoDate}.
 * @param to - The last day, a valid {@link IsoDate}.
 * @returns The days of the range, starting with `from` and ending with `to`, or an empty array when
 *   `from` is after `to`.
 * @throws RangeError when either argument is not a valid {@link IsoDate}.
 */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const start = requireParts(from, 'from');
  const count = inclusiveCount(start, requireParts(to, 'to'));
  const days: IsoDate[] = [];
  // Days are generated by index up to the inclusive count, so the day after `to` is never computed:
  // for `to = 9999-12-31` it would be year 10000, outside IsoDate.
  for (let i = 0; i < count; i += 1) {
    days.push(format(utcMidnight(start.y, start.m, start.d + i)));
  }
  return days;
}

/**
 * Formats an instant for display on pages as `YYYY-MM-DD HH:mm UTC`, for example
 * `2026-10-21 09:15 UTC`. The CSV export writes full ISO 8601 timestamps instead.
 *
 * @param at - The instant to format.
 * @returns The UTC date and minute followed by the `UTC` suffix.
 * @throws RangeError when `at` is an invalid date.
 */
export function formatUtcDateTime(at: Date): string {
  const iso = at.toISOString();
  // Splitting at the `T` rather than a fixed offset keeps extended-year instants readable.
  const timeStart = iso.indexOf('T');
  return `${iso.slice(0, timeStart)} ${iso.slice(timeStart + 1, timeStart + 6)} UTC`;
}

/**
 * Report date-range rules: the default completions range and the validation of ranges submitted
 * for the completions report and the CSV export.
 *
 * Ranges are inclusive at both ends and counted in UTC calendar days. Every function is pure and
 * takes "today" as a parameter, which callers derive from the injected clock.
 */

import type { DateRange, IsoDate } from '../shared/dates';
import { addDays, inclusiveDayCount, parseIsoDate } from '../shared/dates';

/** Longest accepted range, in inclusive days: `to − from + 1` may be at most this value. */
export const MAX_RANGE_DAYS = 366;

/** Length of the default range, in inclusive days ending today. */
export const DEFAULT_RANGE_DAYS = 30;

const INVALID_DATES_MESSAGE = 'Enter valid start and end dates.';
const START_AFTER_END_MESSAGE = 'Start date must be on or before end date.';
const RANGE_TOO_LONG_MESSAGE = 'Date range cannot be longer than 366 days.';

/**
 * Outcome of {@link parseDateRange}: the accepted inclusive range, or the user-facing message to
 * show in place of the report data.
 */
export type DateRangeResult = { ok: true; range: DateRange } | { ok: false; message: string };

/**
 * Returns the default report range: the {@link DEFAULT_RANGE_DAYS} days ending today, both ends
 * included, so `from` is today − 29 and `to` is today.
 *
 * The start date must stay within years `0001`–`9999`, which holds for any real clock. At the upper
 * boundary, today `9999-12-31` gives `9999-12-02` to `9999-12-31`.
 *
 * @param today - The current UTC day.
 * @returns The inclusive range ending on `today`.
 * @throws RangeError when `today` is not a valid {@link IsoDate} or the start would fall before
 *   year `0001`.
 */
export function defaultRange(today: IsoDate): DateRange {
  return { from: addDays(today, -(DEFAULT_RANGE_DAYS - 1)), to: today };
}

/**
 * Validates a report range submitted as `from` and `to` query values.
 *
 * A value is absent only when it is `undefined`, meaning the parameter was not sent. Any string
 * sent, the empty string included, is a supplied value and must parse.
 *
 * Rules, applied in order:
 * - both values absent: the {@link defaultRange} for `today`;
 * - only one absent, or either not a valid `YYYY-MM-DD` date (`''` included): "Enter valid start
 *   and end dates.";
 * - `from` after `to`: "Start date must be on or before end date." Equal dates are a one-day range;
 * - more than {@link MAX_RANGE_DAYS} inclusive days: "Date range cannot be longer than 366 days."
 *
 * Both ends are inclusive, and dates after `today` are allowed: `today` is used only for the
 * default range. Values are not trimmed: they go to the strict {@link parseIsoDate} as sent.
 *
 * @param input - The raw `from` and `to` values, each a string or `undefined` when absent.
 * @param today - The current UTC day.
 * @returns The accepted range, or the message for the first rule that failed.
 * @throws RangeError only from {@link defaultRange}, so only when both values are absent: when
 *   `today` is not a valid {@link IsoDate} or the default start would fall before year `0001`.
 */
export function parseDateRange(
  input: { from?: string; to?: string },
  today: IsoDate,
): DateRangeResult {
  // Range dates are both or neither: only a request sending neither gets the default. An emptied
  // `type=date` field still submits `''`, which counts as supplied and so must parse.
  if (input.from === undefined && input.to === undefined) {
    return { ok: true, range: defaultRange(today) };
  }
  if (input.from === undefined || input.to === undefined) {
    return { ok: false, message: INVALID_DATES_MESSAGE };
  }

  const from = parseIsoDate(input.from);
  const to = parseIsoDate(input.to);
  if (from === null || to === null) {
    return { ok: false, message: INVALID_DATES_MESSAGE };
  }
  // Validated dates have fixed-width four-digit years, so text order is calendar order.
  if (from > to) {
    return { ok: false, message: START_AFTER_END_MESSAGE };
  }
  if (inclusiveDayCount(from, to) > MAX_RANGE_DAYS) {
    return { ok: false, message: RANGE_TOO_LONG_MESSAGE };
  }
  return { ok: true, range: { from, to } };
}

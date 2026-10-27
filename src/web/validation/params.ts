/**
 * Base module of the web validation layer: the shared form-result type, the request field reader,
 * and the parsers for task path parameters, list filters and status values.
 *
 * Every function is pure. Malformed input throws {@link BadRequestError}, which the error handler
 * renders as 400 "Bad request." before any write runs, so no data changes. Inputs come from
 * `express.urlencoded({ extended: false })` bodies and the `'simple'` query parser, both of which
 * yield null-prototype objects whose values are `string`, or `string[]` for a repeated key.
 */

import { BadRequestError } from '../../shared/errors';
import { isTaskPriority, isTaskStatus } from '../../shared/task-values';
import type { TaskStatus } from '../../shared/task-values';
import type { TaskFilters, TaskId } from '../../tasks/types';

/**
 * Outcome of parsing a submitted form.
 *
 * - `ok: true` — `value` is the typed, validated input, ready for the service call.
 * - `ok: false` — `errors` maps a field of the re-render values `V` to its exact user-facing
 *   message, and `values` holds what the page re-renders. `values` never contains a password.
 *
 * A form that shows a message beside a field its values never re-render, such as the sign-up
 * password, refines the failure branch in its own module instead of widening this shared type.
 *
 * @typeParam T - The validated input type.
 * @typeParam V - The raw re-render values type.
 */
export type FormResult<T, V> =
  | { ok: true; value: T }
  | { ok: false; errors: Partial<Record<keyof V, string>>; values: V };

/** Inline message for a status that is not one of the task status labels. */
export const INVALID_STATUS_MESSAGE = 'Choose a valid status.';

/** Inline message for a priority that is not one of the task priority labels. */
export const INVALID_PRIORITY_MESSAGE = 'Choose a valid priority.';

/** A task id: a positive decimal integer of at most 15 digits with no leading zero. */
const TASK_ID_PATTERN = /^[1-9][0-9]{0,14}$/;

/**
 * Reads one field from a parsed request body or query.
 *
 * Returns the value unchanged (no trimming), or `undefined` when the field is absent or `source`
 * is not an object. A field is absent when `source` has no own property of that name (inherited
 * keys are ignored) or its own property holds `undefined`. A repeated parameter arrives as an
 * array, which is a malformed request, so it and any other non-string value (`null`, a number,
 * an object) throw.
 *
 * @param source - `req.body` or `req.query`, typed as `unknown`.
 * @param name - The field name.
 * @returns The submitted string, or `undefined` when the field is absent.
 * @throws {@link BadRequestError} when the value is present but not a single string.
 */
export function readField(source: unknown, name: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  // Parsed bodies and queries have a null prototype, so `source.hasOwnProperty` does not exist and
  // `in` would also see inherited keys; `Object.hasOwn` is safe on both shapes.
  if (!Object.hasOwn(source, name)) {
    return undefined;
  }
  const value: unknown = (source as Readonly<Record<string, unknown>>)[name];
  // An own key holding `undefined`, as `{ status: body.filterStatus }` builds when the echo was
  // not posted, is an absent field: per the list-filter rule an absent value sets no filter.
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestError();
  }
  return value;
}

/**
 * Rejects text that PostgreSQL cannot store.
 *
 * PostgreSQL `text`, whether a column or a bound parameter, cannot hold U+0000, so a field that
 * reaches SQL with one would fail in the database (SQLSTATE 22021) after the request had been
 * accepted. Rejecting it here makes it the malformed request it is: a 400 before any write, so
 * no data changes.
 *
 * @param text - A submitted value that will be bound to a SQL parameter.
 * @throws {@link BadRequestError} when `text` contains U+0000.
 */
export function assertStorableText(text: string): void {
  if (text.includes('\u0000')) {
    throw new BadRequestError();
  }
}

/**
 * Parses the `:id` path parameter of a task route.
 *
 * The id must match `^[1-9][0-9]{0,14}$`. Fifteen digits stay below 2^53, so the conversion to a
 * number is exact. Per the request's example, a malformed request such as a non-numeric task id
 * gets a 400 response and changes no data.
 *
 * @param raw - The raw path segment.
 * @returns The task id.
 * @throws {@link BadRequestError} for anything else, including `abc`, `0`, `01`, `-1`, `1.5`,
 *   16 or more digits, and the empty string.
 */
export function parseTaskId(raw: string): TaskId {
  if (typeof raw !== 'string' || !TASK_ID_PATTERN.test(raw)) {
    throw new BadRequestError();
  }
  return Number(raw);
}

/**
 * Parses the `status` and `priority` task-list filters.
 *
 * An absent or empty value sets no filter, and its key is omitted. An exact label sets that
 * filter. The two filters combine with AND, which `TasksRepo.list` applies. Other keys are
 * ignored. Routes also pass `{ status: body.filterStatus, priority: body.filterPriority }` to
 * validate the filter echoes posted with a status change or delete. An echo that was not posted
 * leaves its key holding `undefined`, which {@link readField} treats as absent, so it sets no
 * filter.
 *
 * @param query - `req.query`, or an object holding the posted filter echoes.
 * @returns The filters to apply.
 * @throws {@link BadRequestError} for an unknown label or a repeated parameter.
 */
export function parseListFilters(query: unknown): TaskFilters {
  const filters: TaskFilters = {};
  const status = readField(query, 'status');
  if (status !== undefined && status !== '') {
    if (!isTaskStatus(status)) {
      throw new BadRequestError();
    }
    filters.status = status;
  }
  const priority = readField(query, 'priority');
  if (priority !== undefined && priority !== '') {
    if (!isTaskPriority(priority)) {
      throw new BadRequestError();
    }
    filters.priority = priority;
  }
  return filters;
}

/**
 * Parses the status posted to `POST /tasks/:id/status`, where an unknown value is malformed
 * rather than an inline form error.
 *
 * @param raw - The submitted `status` field.
 * @returns The status label.
 * @throws {@link BadRequestError} unless `raw` is exactly one status label; an array or
 *   `undefined` also throws.
 */
export function parseStatusValue(raw: unknown): TaskStatus {
  if (!isTaskStatus(raw)) {
    throw new BadRequestError();
  }
  return raw;
}

/**
 * Builds the query string that reproduces a set of list filters.
 *
 * Used for the 303 redirect after a status change or delete (`'/tasks' + filtersToQuery(f)`) and
 * for the filtered Cancel link on the delete confirmation page.
 *
 * @param filters - The active filters.
 * @returns `''` when no filter is set, otherwise `?` followed by `status` then `priority`, each
 *   value URI-encoded, for example `?status=To%20do&priority=High`.
 */
export function filtersToQuery(filters: TaskFilters): string {
  const parts: string[] = [];
  if (filters.status !== undefined) {
    parts.push(`status=${encodeURIComponent(filters.status)}`);
  }
  if (filters.priority !== undefined) {
    parts.push(`priority=${encodeURIComponent(filters.priority)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * Outcome of {@link parseExportStatus}. `status: null` selects every status.
 */
export type ExportStatusResult =
  | { ok: true; status: TaskStatus | null }
  | { ok: false; message: string };

/**
 * Parses the optional status of the CSV export form.
 *
 * An unknown status is a validation failure shown in the export section with 422, not a 400.
 * Callers read `raw` with {@link readField}, so a repeated `status` parameter is still a 400.
 *
 * @param raw - The submitted `status` field, or `undefined` when absent.
 * @returns `{ ok: true, status: null }` for an absent or empty value, `{ ok: true, status }` for
 *   an exact label, and `{ ok: false, message: INVALID_STATUS_MESSAGE }` otherwise.
 */
export function parseExportStatus(raw: string | undefined): ExportStatusResult {
  if (raw === undefined || raw === '') {
    return { ok: true, status: null };
  }
  if (isTaskStatus(raw)) {
    return { ok: true, status: raw };
  }
  return { ok: false, message: INVALID_STATUS_MESSAGE };
}

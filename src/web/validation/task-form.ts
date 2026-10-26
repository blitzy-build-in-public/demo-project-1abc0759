/**
 * Parsing of the task form posted to `POST /tasks/new` and `POST /tasks/:id/edit` (FR-5, FR-6).
 *
 * The function is pure. Every field-level problem is returned as an inline message, all of them at
 * once, together with the raw submitted strings so the page can be re-rendered with the entered
 * values and nothing saved. Only a malformed body throws `BadRequestError` (400): a repeated or
 * non-string field, through {@link readField}, or a title or description containing U+0000,
 * which PostgreSQL text cannot store, through {@link assertStorableText}.
 */

import {
  assertStorableText,
  INVALID_PRIORITY_MESSAGE,
  INVALID_STATUS_MESSAGE,
  readField,
} from './params';
import type { FormResult } from './params';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  isTaskPriority,
  isTaskStatus,
} from '../../shared/task-values';
import type { TaskPriority, TaskStatus } from '../../shared/task-values';
import { parseIsoDate } from '../../shared/dates';
import { DESCRIPTION_MAX_CHARS, TITLE_MAX_CHARS } from '../../tasks/task-rules';
import type { TaskInput } from '../../tasks/types';

// The status and priority messages are defined beside the other status parsers in `./params`;
// re-exporting them makes this module the single import point for every task-form message.
export { INVALID_PRIORITY_MESSAGE, INVALID_STATUS_MESSAGE } from './params';

/** Inline message for a title that is empty or only whitespace. */
export const TITLE_REQUIRED_MESSAGE = 'Title is required.';

/** Inline message for a title longer than `TITLE_MAX_CHARS` code points after trimming. */
export const TITLE_TOO_LONG_MESSAGE = 'Title must be at most 200 characters.';

/** Inline message for a description longer than `DESCRIPTION_MAX_CHARS` code points. */
export const DESCRIPTION_TOO_LONG_MESSAGE = 'Description must be at most 5,000 characters.';

/** Inline message for a due date that is not a real `YYYY-MM-DD` calendar date. */
export const INVALID_DATE_MESSAGE = 'Enter a valid date (YYYY-MM-DD).';

/**
 * The task form's fields exactly as submitted, used to re-render the form after a validation
 * failure.
 *
 * Values are the raw strings, untrimmed, with `''` for an absent field. The template applies the
 * entered-value rules to them: a `dueDate` that is not a valid date is re-rendered in a text field
 * rather than `type=date` (which a browser would empty), and a `status` or `priority` that matches
 * no option gets an extra selected `<value> (invalid)` option. An empty `status` or `priority`
 * shows the default option.
 */
export interface TaskFormValues {
  /** Submitted title, untrimmed. */
  title: string;
  /** Submitted description, with its line breaks as sent. */
  description: string;
  /** Submitted status label, or `''`. */
  status: string;
  /** Submitted priority label, or `''`. */
  priority: string;
  /** Submitted due date text, or `''`. */
  dueDate: string;
}

/**
 * Counts Unicode code points rather than UTF-16 code units, matching PostgreSQL's `char_length`
 * behind the column checks. A 200-code-point title holding 100 characters outside the Basic
 * Multilingual Plane (300 UTF-16 units) is therefore accepted and 201 code points are rejected.
 * HTML `maxlength` counts UTF-16 units, which is why the templates render none.
 */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Validates a submitted task form.
 *
 * Rules, each failure giving its exact inline message:
 * - `title` is trimmed; empty gives {@link TITLE_REQUIRED_MESSAGE}, more than `TITLE_MAX_CHARS`
 *   (200) code points gives {@link TITLE_TOO_LONG_MESSAGE}.
 * - `description` is optional and not trimmed; more than `DESCRIPTION_MAX_CHARS` (5,000) code
 *   points gives {@link DESCRIPTION_TOO_LONG_MESSAGE}. Browsers submit textarea line breaks as
 *   CRLF, and the CR and the LF each count as one code point, because the description is stored
 *   as submitted.
 * - `status` absent or `''` takes `DEFAULT_STATUS` (`To do`); anything but an exact label gives
 *   {@link INVALID_STATUS_MESSAGE}.
 * - `priority` absent or `''` takes `DEFAULT_PRIORITY` (`Medium`); anything but an exact label
 *   gives {@link INVALID_PRIORITY_MESSAGE}.
 * - `dueDate` absent or `''` means no due date; otherwise it must be a real `YYYY-MM-DD` date with
 *   a year from `0001` to `9999`, untrimmed, or it gives {@link INVALID_DATE_MESSAGE}.
 *
 * Other body fields, such as `_csrf`, are ignored.
 *
 * @param body - `req.body` from `express.urlencoded({ extended: false })`, typed as `unknown`.
 * @returns `{ ok: true, value }` with the trimmed title and the other fields as validated, or
 *   `{ ok: false, errors, values }` with every failed field's message and the raw submitted values.
 * @throws `BadRequestError` when a field is repeated or otherwise not a single string, or when
 *   the title or description contains U+0000.
 */
export function parseTaskForm(body: unknown): FormResult<TaskInput, TaskFormValues> {
  const values: TaskFormValues = {
    title: readField(body, 'title') ?? '',
    description: readField(body, 'description') ?? '',
    status: readField(body, 'status') ?? '',
    priority: readField(body, 'priority') ?? '',
    dueDate: readField(body, 'dueDate') ?? '',
  };
  // A malformed request returns 400 and changes no data. PostgreSQL text cannot store U+0000, so
  // a title or description holding one is malformed rather than an inline error. The other
  // fields reach SQL only as an exact label or a valid date, so they need no such check.
  assertStorableText(values.title);
  assertStorableText(values.description);
  const errors: Partial<Record<keyof TaskFormValues, string>> = {};

  const title = values.title.trim();
  if (title === '') {
    errors.title = TITLE_REQUIRED_MESSAGE;
  } else if (codePointLength(title) > TITLE_MAX_CHARS) {
    errors.title = TITLE_TOO_LONG_MESSAGE;
  }

  if (codePointLength(values.description) > DESCRIPTION_MAX_CHARS) {
    errors.description = DESCRIPTION_TOO_LONG_MESSAGE;
  }

  let status: TaskStatus | null = null;
  if (values.status === '') {
    status = DEFAULT_STATUS;
  } else if (isTaskStatus(values.status)) {
    status = values.status;
  } else {
    errors.status = INVALID_STATUS_MESSAGE;
  }

  let priority: TaskPriority | null = null;
  if (values.priority === '') {
    priority = DEFAULT_PRIORITY;
  } else if (isTaskPriority(values.priority)) {
    priority = values.priority;
  } else {
    errors.priority = INVALID_PRIORITY_MESSAGE;
  }

  const dueDate = values.dueDate === '' ? null : parseIsoDate(values.dueDate);
  if (values.dueDate !== '' && dueDate === null) {
    errors.dueDate = INVALID_DATE_MESSAGE;
  }

  // A null status or priority always has its message in `errors`; testing them here as well
  // narrows both to their label types for the success value.
  if (status === null || priority === null || Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }
  return {
    ok: true,
    value: { title, description: values.description, status, priority, dueDate },
  };
}

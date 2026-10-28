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

/**
 * The inline status and priority messages, re-exported unchanged from `./params`.
 *
 * `INVALID_STATUS_MESSAGE` and `INVALID_PRIORITY_MESSAGE` are defined beside the other status
 * parsers in `./params`. Re-exporting them makes this module the single import point for every
 * task-form message.
 */
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
 * The task form's fields as submitted, used to re-render the form after a validation failure.
 *
 * Values are the raw strings, untrimmed. An absent `title`, `description` or `dueDate` is `''`.
 * An absent `status` or `priority` holds the default it took (`To do`, `Medium`), so the form
 * shows that default again; a submitted one is kept as sent, and `''` is a blank submission,
 * which is invalid. The template applies the entered-value rules to them: a `dueDate` that is not
 * a valid date is re-rendered in a text field rather than `type=date` (which a browser would
 * empty), and a `status` or `priority` that matches no option, a blank one included, gets an
 * extra selected `<value> (invalid)` option.
 */
export interface TaskFormValues {
  /**
   * Submitted title, untrimmed; on an edit, the stored title when the submission is that title
   * with the CRLF line breaks a browser submits.
   */
  title: string;
  /**
   * Submitted description, with its line breaks as sent; on an edit, the stored description when
   * the submission is that description with the CRLF line breaks a browser submits.
   */
  description: string;
  /** Submitted status, `''` when sent blank, or `DEFAULT_STATUS` when the field was absent. */
  status: string;
  /** Submitted priority, `''` when sent blank, or `DEFAULT_PRIORITY` when the field was absent. */
  priority: string;
  /** Submitted due date text, or `''`. */
  dueDate: string;
}

/**
 * Body field names of the task form posted to `POST /tasks/new` and `POST /tasks/:id/edit`, one
 * per {@link TaskFormValues} field. The task form's controls render these names and
 * {@link parseTaskForm} reads them, so a control and its parser share one spelling.
 */
export const TASK_FORM_FIELDS = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  dueDate: 'dueDate',
} as const satisfies Record<keyof TaskFormValues, string>;

/**
 * Counts Unicode code points rather than UTF-16 code units, matching PostgreSQL's `char_length`
 * behind the column checks. A 200-code-point title holding 100 characters outside the Basic
 * Multilingual Plane (300 UTF-16 units) is therefore accepted and 201 code points are rejected.
 * HTML `maxlength` counts UTF-16 units, which is why the templates render none.
 */
function codePointLength(text: string): number {
  return [...text].length;
}

/** A line break in any form: CRLF, or a lone CR or LF. */
const ANY_LINE_BREAK = /\r\n|\r|\n/g;

/**
 * `text` as a browser submits it from a form control. The HTML Standard's conversion of a form's
 * entry list to name-value pairs replaces every CR not followed by LF, and every LF not preceded
 * by CR, with CRLF, so no form can submit a lone CR or LF.
 */
function asFormSubmitted(text: string): string {
  return text.replace(ANY_LINE_BREAK, '\r\n');
}

/**
 * The submitted title or description to validate, `stored` being the edited task's text of the
 * same field. A browser cannot send back a lone CR or LF of the stored text, so a submission
 * equal to the stored text as {@link asFormSubmitted} writes it is the field left alone, and the
 * stored text is kept. Any other submission, and every submission when nothing is stored, is
 * changed text, taken exactly as sent.
 */
function submittedText(raw: string, stored: string | undefined): string {
  if (stored !== undefined && raw !== stored && raw === asFormSubmitted(stored)) {
    return stored;
  }
  return raw;
}

/**
 * Validates a submitted task form.
 *
 * Rules, each failure giving its exact inline message:
 * - `title` is trimmed; empty gives {@link TITLE_REQUIRED_MESSAGE}, more than `TITLE_MAX_CHARS`
 *   (200) code points gives {@link TITLE_TOO_LONG_MESSAGE}. On an edit, a submitted title that
 *   equals `stored.title` once each of its line breaks is written as CRLF, the form a browser
 *   submits, is `stored.title` itself, so an edit that leaves the title alone never alters it.
 * - `description` is optional and not trimmed; more than `DESCRIPTION_MAX_CHARS` (5,000) code
 *   points gives {@link DESCRIPTION_TOO_LONG_MESSAGE}. It is stored as submitted: browsers submit
 *   textarea line breaks as CRLF, and the CR and the LF each count as one code point. On an edit,
 *   a submitted description that equals `stored.description` once each of its line breaks is
 *   written as CRLF is `stored.description` itself, so an edit that leaves the description alone
 *   never alters or lengthens it.
 * - `status` absent takes `DEFAULT_STATUS` (`To do`); a submitted value that is not an exact
 *   label, `''` included, gives {@link INVALID_STATUS_MESSAGE}.
 * - `priority` absent takes `DEFAULT_PRIORITY` (`Medium`); a submitted value that is not an exact
 *   label, `''` included, gives {@link INVALID_PRIORITY_MESSAGE}.
 * - `dueDate` absent or `''` means no due date; otherwise it must be a real `YYYY-MM-DD` date with
 *   a year from `0001` to `9999`, untrimmed, or it gives {@link INVALID_DATE_MESSAGE}.
 *
 * Other body fields, such as `_csrf`, are ignored.
 *
 * @param body - `req.body` from `express.urlencoded({ extended: false })`, typed as `unknown`.
 * @param stored - The edited task's stored title and description; omitted when creating a task.
 *   When a submitted title or description differs from its stored text only by line breaks
 *   written as CRLF, the stored text is the one validated, returned and re-rendered, its line
 *   breaks kept exactly. Every rule of that field and the U+0000 check apply to it as to any
 *   submitted text.
 * @returns `{ ok: true, value }` with the trimmed title and the other fields as validated, or
 *   `{ ok: false, errors, values }` with every failed field's message and the submitted values,
 *   as {@link TaskFormValues} records them.
 * @throws `BadRequestError` when a field is repeated or otherwise not a single string, or when
 *   the title or description contains U+0000.
 */
export function parseTaskForm(
  body: unknown,
  stored?: Pick<TaskInput, 'title' | 'description'>,
): FormResult<TaskInput, TaskFormValues> {
  // Only a missing status or priority takes the default. A blank one was submitted, so like any
  // other value that is not an exact label it is invalid, and it is kept for the re-render.
  const values: TaskFormValues = {
    title: submittedText(readField(body, TASK_FORM_FIELDS.title) ?? '', stored?.title),
    description: submittedText(
      readField(body, TASK_FORM_FIELDS.description) ?? '',
      stored?.description,
    ),
    status: readField(body, TASK_FORM_FIELDS.status) ?? DEFAULT_STATUS,
    priority: readField(body, TASK_FORM_FIELDS.priority) ?? DEFAULT_PRIORITY,
    dueDate: readField(body, TASK_FORM_FIELDS.dueDate) ?? '',
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
  if (isTaskStatus(values.status)) {
    status = values.status;
  } else {
    errors.status = INVALID_STATUS_MESSAGE;
  }

  let priority: TaskPriority | null = null;
  if (isTaskPriority(values.priority)) {
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

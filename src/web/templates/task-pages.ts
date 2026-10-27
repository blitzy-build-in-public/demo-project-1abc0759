/**
 * Task pages: the task list, the task form (new and edit) and the delete confirmation.
 *
 * Every function is pure and renders only through the escaping {@link html} tag, so task titles
 * and descriptions can never inject markup. Delete works with and without JavaScript: every
 * Delete button posts to `/tasks/:id/delete` without `confirm=yes`, so without scripts the server
 * answers with {@link renderDeleteConfirmPage}; with scripts `/static/confirm-delete.js` asks
 * `window.confirm` and, on OK, sets the hidden `confirm` field of the button's form to `yes`.
 */

import type { AuthenticatedUser } from '../../auth/auth-service';
import { formatUtcDateTime } from '../../shared/dates';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../../shared/task-values';
import type { Task, TaskFilters, TaskId } from '../../tasks/types';
import { filtersToQuery } from '../validation/params';
import type { TaskFormValues } from '../validation/task-form';
import { html, type SafeHtml } from './html';
import {
  csrfField,
  dateInput,
  describedBy,
  fieldError,
  renderLayout,
  selectOptions,
  type SelectOption,
} from './layout';

/** View model of the task list page (`GET /tasks`). */
export interface TaskListPageView {
  /** The signed-in user, shown in the header. */
  user: AuthenticatedUser;
  /** The response's CSRF token, carried by the shared actions form and the Log out form. */
  csrfToken: string;
  /** The matching tasks, already sorted by due date soonest first, undated last, then id. */
  tasks: readonly Task[];
  /**
   * Whether the user has any task at all, ignoring the filters. With no matching tasks it selects
   * "You have no tasks yet." (`false`) or "No tasks match these filters." (`true`).
   */
  ownerHasTasks: boolean;
  /** The active, already validated filters, preselected in the filter form and echoed in posts. */
  filters: TaskFilters;
}

/** View model of the task form page (`/tasks/new` and `/tasks/:id/edit`, GET and failed POST). */
export interface TaskFormPageView {
  /** The signed-in user, shown in the header. */
  user: AuthenticatedUser;
  /** The response's CSRF token, carried by every form on the page. */
  csrfToken: string;
  /** `new` posts to `/tasks/new`; `edit` posts to `/tasks/:id/edit` and adds the Delete form. */
  mode: 'new' | 'edit';
  /** Id of the edited task, used in edit mode when `task` is absent. */
  taskId?: TaskId;
  /**
   * The stored task in edit mode. It supplies the id, the created and completed times and the
   * title the delete confirmation names, which stays the stored one while an edit is invalid.
   */
  task?: Task;
  /** Field values to show: the stored or default values, or exactly what was just submitted. */
  values: TaskFormValues;
  /** Inline message per invalid field, rendered verbatim; empty when the form is valid. */
  errors: Partial<Record<keyof TaskFormValues, string>>;
}

/** View model of the delete confirmation page (`POST /tasks/:id/delete` without `confirm=yes`). */
export interface DeleteConfirmPageView {
  /** The signed-in user, shown in the header. */
  user: AuthenticatedUser;
  /** The response's CSRF token, carried by the confirmation form. */
  csrfToken: string;
  /** The task about to be deleted. */
  task: Task;
  /** The list filters posted with the Delete button, kept for the redirect and the Cancel link. */
  filters: TaskFilters;
}

/** A task status label. */
type Status = Task['status'];

/** Status options of the task form, in display order. */
const STATUS_OPTIONS: readonly SelectOption[] = TASK_STATUSES.map((s) => ({ value: s, label: s }));

/** Priority options of the task form, in display order. */
const PRIORITY_OPTIONS: readonly SelectOption[] = TASK_PRIORITIES.map((p) => ({
  value: p,
  label: p,
}));

/** The "All" option of a list filter; its empty value sets no filter. */
const ALL_OPTION: SelectOption = { value: '', label: 'All' };

/** Status filter options of the task list. */
const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [ALL_OPTION, ...STATUS_OPTIONS];

/** Priority filter options of the task list. */
const PRIORITY_FILTER_OPTIONS: readonly SelectOption[] = [ALL_OPTION, ...PRIORITY_OPTIONS];

/** The statuses other than one, in display order: the two "Mark <status>" buttons of a row. */
function statusesOtherThan(status: Status): readonly Status[] {
  return TASK_STATUSES.filter((s) => s !== status);
}

/** Computed once rather than per row, because the list can hold 10,000 rows. */
const OTHER_STATUSES: Readonly<Record<Status, readonly Status[]>> = {
  'To do': statusesOtherThan('To do'),
  'In progress': statusesOtherThan('In progress'),
  Done: statusesOtherThan('Done'),
};

/** Shown in the due-date column of an undated task. */
const NO_DUE_DATE = '\u2014';

/** Whether a field carries an inline message, using the same rule as {@link fieldError}. */
function hasError(message: string | undefined): message is string {
  return message !== undefined && message !== '';
}

/** ` aria-invalid="true"` for a field with an inline message, otherwise nothing. */
function invalidAttr(message: string | undefined): SafeHtml | false {
  return hasError(message) && html` aria-invalid="true"`;
}

/** Hidden echoes of the active list filters, read back by the status and delete routes. */
function filterEchoes(filters: TaskFilters): SafeHtml {
  return html`<input type="hidden" name="filterStatus" value="${filters.status ?? ''}">
    <input type="hidden" name="filterPriority" value="${filters.priority ?? ''}">`;
}

/**
 * One task row. Its buttons submit the shared `#task-actions` form that wraps the table, each to
 * its own `formaction`, so a row carries no form, CSRF field or hidden input of its own: the list
 * renders every matching task, up to 10,000 rows, within the 2-second page budget. Source line
 * breaks fall only inside `${}` expressions, so a row's markup holds no whitespace beyond single
 * attribute separators.
 */
function renderTaskRow(t: Task): SafeHtml {
  const marks = OTHER_STATUSES[t.status].map(
    (s) => html`<button type="submit" formaction="/tasks/${
      t.id
    }/status" name="status" value="${s}">Mark ${s}</button>`,
  );
  const remove = html`<button type="submit" formaction="/tasks/${
    t.id
  }/delete" data-confirm-delete data-task-title="${t.title}">Delete</button>`;
  return html`<tr><td><a href="/tasks/${t.id}/edit">${t.title}</a></td><td>${t.status}</td><td>${
    t.priority
  }</td><td>${t.dueDate ?? NO_DUE_DATE}</td><td>${marks}${remove}</td></tr>`;
}

/**
 * The list body below the filter form: one of the two empty states, or the shared actions form
 * holding the task table.
 */
function renderTaskListContent(view: TaskListPageView): SafeHtml {
  const { tasks, ownerHasTasks, filters, csrfToken } = view;
  if (tasks.length === 0) {
    return ownerHasTasks
      ? html`<p class="empty">No tasks match these filters.</p>
    <p><a href="/tasks">Clear filters</a></p>`
      : html`<p class="empty">You have no tasks yet.</p>
    <p><a href="/tasks/new">Create a task</a></p>`;
  }
  // Rendered in the order given: the repository already sorts by due date, undated last, then id.
  const rows = tasks.map(renderTaskRow);
  // The row buttons belong to this one form by ancestry, not through a `form="task-actions"`
  // attribute on each: Chromium associates form-attribute controls at a cost that grows with the
  // square of their number, which measured about 29 s for 10,000 rows (30,000 buttons) against
  // about 1.3 s nested, so the attribute would break the 2-second list budget. The form holds no
  // text input, so pressing Enter can never submit it implicitly; only a row button, with its own
  // formaction, submits it, and confirm-delete.js sets `confirm` to `yes` for a confirmed Delete.
  return html`<form id="task-actions" method="post" action="/tasks">${csrfField(csrfToken)}
    ${filterEchoes(filters)}
    <input type="hidden" name="confirm" value="">
    <table class="task-table">
      <thead>
        <tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Priority</th><th
          scope="col">Due date</th><th scope="col">Actions</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </form>`;
}

/**
 * Renders the task list page: the filter form, then the shared actions form and the task table,
 * or the empty state that applies.
 *
 * - No task at all: "You have no tasks yet." with a "Create a task" link to `/tasks/new`.
 * - Tasks exist but none match the filters: "No tasks match these filters." with a
 *   "Clear filters" link to `/tasks`.
 * - Otherwise one row per task with its title linked to the edit page, status, priority, due date
 *   (`YYYY-MM-DD`, or an em dash when undated), a "Mark <status>" button for each of the two other
 *   statuses and a Delete button, all submitting the single `#task-actions` form.
 *
 * @param view - The user, CSRF token, tasks, whether the user has any task, and active filters.
 * @returns The complete HTML document, loading `/static/confirm-delete.js`.
 */
export function renderTaskListPage(view: TaskListPageView): string {
  const { user, csrfToken, filters } = view;
  // Filters reach the page already validated, so no "(invalid)" option can appear here.
  const body = html`<h1>Tasks</h1>
    <p><a href="/tasks/new">New task</a></p>
    <form method="get" action="/tasks" class="filters">
      <label for="filter-status">Status</label>
      <select id="filter-status" name="status">${selectOptions(
        STATUS_FILTER_OPTIONS,
        filters.status ?? '',
      )}</select>
      <label for="filter-priority">Priority</label>
      <select id="filter-priority" name="priority">${selectOptions(
        PRIORITY_FILTER_OPTIONS,
        filters.priority ?? '',
      )}</select>
      <button type="submit">Apply filters</button>
      <a href="/tasks">Clear filters</a>
    </form>
    ${renderTaskListContent(view)}`;
  return renderLayout({ title: 'Tasks', user, csrfToken, body, scripts: ['confirm-delete'] });
}

/**
 * The edited task's id: the stored task's, else `taskId`. Edit mode without either is a
 * programming error in the caller, never something a request can cause, so it surfaces as a 500.
 */
function editTaskId(view: TaskFormPageView): TaskId {
  const id = view.task?.id ?? view.taskId;
  if (id === undefined) {
    throw new Error('edit mode requires task or taskId');
  }
  return id;
}

/**
 * The fields, Save button and Cancel link of the task form.
 *
 * No `maxlength` is set on the title or description: it counts UTF-16 code units, so a valid
 * 200-code-point title holding characters outside the Basic Multilingual Plane would be blocked by
 * the browser. The server's code-point check is the only length limit.
 */
function renderTaskFields(view: TaskFormPageView): SafeHtml {
  const { values, errors, csrfToken } = view;
  const status = values.status === '' ? DEFAULT_STATUS : values.status;
  const priority = values.priority === '' ? DEFAULT_PRIORITY : values.priority;
  // The line feed right after <textarea> is required: the HTML parser drops one leading line feed
  // there, so without it a description that begins with a line break would lose it on each edit.
  return html`${csrfField(csrfToken)}
      <label for="title">Title</label>
      <input type="text" id="title" name="title" required value="${values.title}"${describedBy(
        'title-hint',
        errors.title && 'title-error',
      )}${invalidAttr(errors.title)}>
      <p class="hint" id="title-hint">Up to 200 characters</p>
      ${fieldError('title-error', errors.title)}
      <label for="description">Description</label>
      <textarea id="description" name="description" rows="6"${describedBy(
        'description-hint',
        errors.description && 'description-error',
      )}${invalidAttr(errors.description)}>\n${values.description}</textarea>
      <p class="hint" id="description-hint">Up to 5,000 characters</p>
      ${fieldError('description-error', errors.description)}
      <label for="status">Status</label>
      <select id="status" name="status"${describedBy(errors.status && 'status-error')}${invalidAttr(
        errors.status,
      )}>${selectOptions(STATUS_OPTIONS, status)}</select>
      ${fieldError('status-error', errors.status)}
      <label for="priority">Priority</label>
      <select id="priority" name="priority"${describedBy(
        errors.priority && 'priority-error',
      )}${invalidAttr(errors.priority)}>${selectOptions(PRIORITY_OPTIONS, priority)}</select>
      ${fieldError('priority-error', errors.priority)}
      <label for="dueDate">Due date</label>
      ${dateInput({
        id: 'dueDate',
        name: 'dueDate',
        value: values.dueDate,
        describedBy: [errors.dueDate && 'dueDate-error'],
        invalid: hasError(errors.dueDate),
      })}
      ${fieldError('dueDate-error', errors.dueDate)}
      <button type="submit">Save</button>
      <a href="/tasks">Cancel</a>`;
}

/**
 * The edit page's read-only times and its separate Delete form, placed after the edit form
 * because forms cannot nest. The Delete button names the stored title, so the confirmation shows
 * the task being deleted even while an invalid edit is on screen.
 */
function renderEditExtras(view: TaskFormPageView, id: TaskId): SafeHtml {
  const { task, values, csrfToken } = view;
  const times =
    task !== undefined &&
    html`<p class="meta">Created ${formatUtcDateTime(task.createdAt)}</p>${
      task.completedAt !== null &&
      html`
    <p class="meta">Completed ${formatUtcDateTime(task.completedAt)}</p>`
    }`;
  return html`${times}
    <form method="post" action="/tasks/${id}/delete">${csrfField(csrfToken)}
      <input type="hidden" name="confirm" value="">
      <button type="submit" data-confirm-delete data-task-title="${task?.title ?? values.title}"
        >Delete</button>
    </form>`;
}

/**
 * Renders the new-task or edit-task form page, initially or after a failed submission.
 *
 * Every field keeps the value in `view.values`: text and the description as given (line breaks
 * included); an empty status or priority shows its default (To do, Medium); a status or priority
 * matching no option shows an extra selected "<value> (invalid)" option; a due date that is not a
 * valid date stays visible in a text field. Each message in `view.errors` appears verbatim beside
 * its field, linked through `aria-describedby`, and the field is marked `aria-invalid`.
 *
 * In edit mode the page also shows the created time, the completed time when set (both in UTC),
 * and a separate Delete form, and loads `/static/confirm-delete.js`.
 *
 * @param view - The user, CSRF token, mode, task or id, field values and inline errors.
 * @returns The complete HTML document.
 * @throws Error when `mode` is `edit` and neither `task` nor `taskId` is given.
 */
export function renderTaskFormPage(view: TaskFormPageView): string {
  const { user, csrfToken, mode } = view;
  if (mode === 'new') {
    const body = html`<h1>New task</h1>
    <form method="post" action="/tasks/new">
      ${renderTaskFields(view)}
    </form>`;
    return renderLayout({ title: 'New task', user, csrfToken, body });
  }
  const id = editTaskId(view);
  const body = html`<h1>Edit task</h1>
    <form method="post" action="/tasks/${id}/edit">
      ${renderTaskFields(view)}
    </form>
    ${renderEditExtras(view, id)}`;
  return renderLayout({ title: 'Edit task', user, csrfToken, body, scripts: ['confirm-delete'] });
}

/**
 * Renders the delete confirmation page, the no-JavaScript confirmation step: the server answers
 * a Delete that arrived without `confirm=yes` with this page and changes nothing.
 *
 * It shows "Delete this task?" and the task's title, a form posting `confirm=yes` with the CSRF
 * field and the list-filter echoes to `/tasks/:id/delete` through a "Delete task" button, and a
 * Cancel link back to the filtered list. The button carries no `data-confirm-delete`, because it
 * is itself the confirmation, and the page loads no script.
 *
 * @param view - The user, CSRF token, task and active list filters.
 * @returns The complete HTML document.
 */
export function renderDeleteConfirmPage(view: DeleteConfirmPageView): string {
  const { user, csrfToken, task, filters } = view;
  const body = html`<h1>Delete this task?</h1>
    <p class="task-title">${task.title}</p>
    <form method="post" action="/tasks/${task.id}/delete">${csrfField(csrfToken)}
      <input type="hidden" name="confirm" value="yes">
      ${filterEchoes(filters)}
      <button type="submit">Delete task</button>
      <a href="/tasks${filtersToQuery(filters)}">Cancel</a>
    </form>`;
  return renderLayout({ title: 'Delete task', user, csrfToken, body });
}


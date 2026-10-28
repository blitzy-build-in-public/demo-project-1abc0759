/**
 * Pure task rules: the field-length limits, the completion-time rule (FR-10) and the list-filter
 * match.
 *
 * Every function is free of I/O and never reads the system time; the current instant arrives as
 * the `now` argument, which the task service takes from the injected clock. Status and priority
 * defaults live in `src/shared/task-values.ts`, and the validation messages live in
 * `parseTaskForm` (`src/web/validation/task-form.ts`), which imports the limits below.
 */

import type { TaskRecord, TaskUpdateRow } from '../db/types';
import type { TaskStatus } from '../shared/task-values';
import type { TaskFilters, TaskInput } from './types';

// HTML `maxlength` counts UTF-16 code units, so a title of 200 code points that uses characters
// outside the Basic Multilingual Plane would be blocked by the browser although it is valid. No
// `maxlength` is rendered for these fields, which makes these constants the single source of the
// limits, checked server-side in code points.

/**
 * Maximum title length in Unicode code points, counted after trimming.
 *
 * Exactly 200 is accepted and 201 is rejected with "Title must be at most 200 characters." It
 * matches `CHECK (char_length(title) BETWEEN 1 AND 200)` in `0003_create_tasks.sql`, because
 * PostgreSQL's `char_length` also counts code points.
 */
export const TITLE_MAX_CHARS = 200;

/**
 * Maximum description length in Unicode code points. The description is not trimmed.
 *
 * Exactly 5,000 is accepted and 5,001 is rejected with "Description must be at most 5,000
 * characters." It matches `CHECK (char_length(description) <= 5000)` in `0003_create_tasks.sql`.
 */
export const DESCRIPTION_MAX_CHARS = 5000;

/** The status whose entry records a completion time. */
const DONE: TaskStatus = 'Done';

/**
 * Computes a task's completion time after it moves to `nextStatus` (FR-10).
 *
 * - `nextStatus` is not `Done`: `null`. Leaving `Done` clears the time, and every other
 *   transition between open statuses leaves it `null`.
 * - Creation (`previous` is `null`) as `Done`: `now`.
 * - Entering `Done` from another status: `now`.
 * - Staying `Done`: preserves a non-null `previous.completedAt`; a caller-built `Done` value with
 *   no completion time (`completedAt` is `null`) gets `now`.
 *
 * The returned `Date` is the very instance passed in (`now` or `previous.completedAt`), never a
 * copy.
 *
 * @param previous - The task's stored status and completion time, or `null` for a new task.
 * @param nextStatus - The status the task is moving to, which may equal its current one.
 * @param now - The current instant, from the injected clock.
 * @returns The completion time to store, or `null` when the task is not `Done`.
 */
export function nextCompletedAt(
  previous: { status: TaskStatus; completedAt: Date | null } | null,
  nextStatus: TaskStatus,
  now: Date,
): Date | null {
  if (nextStatus !== DONE) {
    return null;
  }
  if (previous === null || previous.status !== DONE) {
    return now;
  }
  // A stored `Done` row always has a completion time (table check
  // `(status = 'Done') = (completed_at IS NOT NULL)`), so the fallback never fires for one; it only
  // keeps the result non-null for a caller-built value, preserving the `Done` ⇔ time invariant.
  return previous.completedAt ?? now;
}

/**
 * Tells whether a task belongs to the list that `filters` select: each filter that is set must
 * equal the task's value exactly, and the two combine with AND. This is the rule `TasksRepo.list`
 * applies in SQL, so a task that passes it is a row of that list.
 *
 * @param task - The task's status and priority.
 * @param filters - Exact-match status and priority filters; an absent field matches every task.
 * @returns Whether every set filter matches.
 */
export function matchesTaskFilters(
  task: Pick<TaskRecord, 'status' | 'priority'>,
  filters: TaskFilters,
): boolean {
  return (
    (filters.status === undefined || filters.status === task.status) &&
    (filters.priority === undefined || filters.priority === task.priority)
  );
}

/**
 * Builds the full replacement row for an edit or a status change of an existing task.
 *
 * Every input field is copied as given, `completedAt` comes from {@link nextCompletedAt}, and
 * `updatedAt` is always `now`. A change that keeps the status, such as a priority-only change,
 * therefore leaves the status and the completion time (set or `null`) exactly as they were in
 * every status. `TaskService.changeStatus` passes the task's current title, description, priority
 * and due date with only the status replaced, so it shares this rule with a full edit.
 *
 * @param current - The task's stored status and completion time; not modified.
 * @param input - The validated new field values; not modified.
 * @param now - The current instant, from the injected clock.
 * @returns A new object holding exactly the fields of {@link TaskUpdateRow}.
 */
export function buildTaskUpdate(
  current: Pick<TaskRecord, 'status' | 'completedAt'>,
  input: TaskInput,
  now: Date,
): TaskUpdateRow {
  // Fields are listed one by one rather than spread from `input`, so a caller's object carrying
  // extra properties cannot pass them through to the repository.
  return {
    title: input.title,
    description: input.description,
    status: input.status,
    priority: input.priority,
    dueDate: input.dueDate,
    completedAt: nextCompletedAt(current, input.status, now),
    updatedAt: now,
  };
}

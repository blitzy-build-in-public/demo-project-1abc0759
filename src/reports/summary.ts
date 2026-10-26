/**
 * Summary report rules: the overdue test and the open-task counts shown on `/reports`.
 *
 * Every function is pure and takes "today" as a parameter, which callers derive in UTC from the
 * injected clock with `todayUtc`. The data-access layer returns open tasks already grouped by
 * status, priority and due date, and this module applies the overdue rule per group, so the rule
 * has a single implementation.
 */

import type { OpenTaskGroup } from '../db/types';
import type { IsoDate } from '../shared/dates';
import type { TaskPriority, TaskStatus } from '../shared/task-values';
import { OPEN_STATUSES } from '../shared/task-values';

/** A status that counts as open: `To do` or `In progress`. */
type OpenStatus = (typeof OPEN_STATUSES)[number];

/**
 * The summary report for one user.
 *
 * Open tasks are those in `To do` or `In progress`; `Done` tasks appear in no count. With no open
 * tasks every count is 0.
 */
export interface SummaryReport {
  /** Number of open tasks in each open status. */
  openByStatus: { 'To do': number; 'In progress': number };
  /** Number of open tasks with each priority. */
  openByPriority: Record<TaskPriority, number>;
  /** Number of open tasks whose due date is earlier than today (UTC). */
  overdue: number;
}

/**
 * Reports whether a task is overdue: it has a due date earlier than today (UTC) and its status is
 * not `Done`.
 *
 * A task due today is not overdue, an undated task is never overdue, and a `Done` task is not
 * overdue whatever its due date.
 *
 * @param dueDate - The task's due date, or `null` when it has none.
 * @param status - The task's current status.
 * @param today - The current UTC day, from `todayUtc`.
 * @returns `true` when the task is overdue.
 */
export function isOverdue(dueDate: IsoDate | null, status: TaskStatus, today: IsoDate): boolean {
  // IsoDate values have fixed-width four-digit years, so text order is calendar order.
  return dueDate !== null && dueDate < today && status !== 'Done';
}

/**
 * Narrows a status to an open one. The parameter is the full {@link TaskStatus} so the check stays
 * meaningful for a group whose runtime value contradicts its static type.
 */
function isOpenStatus(status: TaskStatus): status is OpenStatus {
  return (OPEN_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Builds the summary report from an owner's open tasks grouped by status, priority and due date.
 *
 * Each group's `count` is added to its status, to its priority and, when {@link isOverdue} holds
 * for its due date and status, to the overdue total. Every count starts at 0, so an empty list
 * yields an all-zero report rather than an error.
 *
 * @param groups - The groups from `TasksRepo.openTaskGroups`; not modified.
 * @param today - The current UTC day, from `todayUtc`.
 * @returns A new report object.
 */
export function summarize(groups: readonly OpenTaskGroup[], today: IsoDate): SummaryReport {
  const openByStatus: SummaryReport['openByStatus'] = { 'To do': 0, 'In progress': 0 };
  const openByPriority: SummaryReport['openByPriority'] = { Low: 0, Medium: 0, High: 0 };
  let overdue = 0;

  for (const group of groups) {
    // The repository excludes `Done` and the type forbids it, but a group that still carries a
    // non-open status is skipped so the report never counts it or gains a key beyond the two open
    // statuses.
    if (!isOpenStatus(group.status)) {
      continue;
    }
    openByStatus[group.status] += group.count;
    openByPriority[group.priority] += group.count;
    if (isOverdue(group.dueDate, group.status, today)) {
      overdue += group.count;
    }
  }

  return { openByStatus, openByPriority, overdue };
}

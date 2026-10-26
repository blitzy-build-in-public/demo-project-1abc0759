/**
 * Public types of the task module, used by the task service, the task rules and the web layer.
 *
 * The file holds types only and compiles to an empty module.
 */

import type { TaskListFilters, TaskRecord } from '../db/types';
import type { IsoDate } from '../shared/dates';
import type { TaskPriority, TaskStatus } from '../shared/task-values';

// The web layer must never import `src/db/**`, so it reaches the id aliases through this module.
// `isolatedModules` requires the `export type` form for a type-only re-export.
export type { TaskId, UserId } from '../db/types';

/**
 * A task as seen above the data-access layer.
 *
 * The owner id is deliberately absent: every task that reaches callers has already been read
 * through an owner-scoped repository query, so the owner is always the requesting user. `dueDate`
 * is `YYYY-MM-DD` text, never a `Date`, and `completedAt` is set exactly when `status` is `Done`.
 */
export type Task = Omit<TaskRecord, 'ownerId'>;

/**
 * Validated user input for creating or editing a task, as produced by `parseTaskForm`.
 *
 * Every field is already checked when this value exists; the task service applies it as given.
 */
export interface TaskInput {
  /** Trimmed title of 1 to 200 code points. */
  title: string;
  /** Untrimmed description of up to 5,000 code points, `''` when none was submitted. */
  description: string;
  /** The task's status label. */
  status: TaskStatus;
  /** The task's priority label. */
  priority: TaskPriority;
  /** Due date as a valid `YYYY-MM-DD` date, or `null` when none was submitted. */
  dueDate: IsoDate | null;
}

/**
 * Exact-match filters for the task list. An absent field means no filter on it, and the two
 * combine with AND.
 */
export type TaskFilters = TaskListFilters;

/** One owner's filtered task list, returned by `TaskService.list`. */
export interface TaskListResult {
  /** The matching tasks, sorted by due date soonest first with undated tasks last, then by id. */
  tasks: Task[];
  /**
   * Whether the owner has any task at all, ignoring the filters. It tells the two empty states
   * apart: `false` shows "You have no tasks yet.", and `true` with no `tasks` shows "No tasks match
   * these filters." It is always `true` when `tasks` is non-empty.
   */
  ownerHasTasks: boolean;
}

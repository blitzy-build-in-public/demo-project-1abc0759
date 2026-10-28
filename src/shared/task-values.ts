/**
 * Task status and priority vocabularies shared by every layer.
 *
 * The labels are the exact values stored in the `tasks.status` and `tasks.priority` columns and the
 * values shown on pages and in the CSV export. They must stay byte-for-byte equal to the `CHECK`
 * lists in `src/db/migrations/0003_create_tasks.sql`.
 */

/**
 * Every task status, in display order. The order drives select options, filter lists and the
 * "Mark <status>" buttons.
 */
export const TASK_STATUSES = ['To do', 'In progress', 'Done'] as const;

/** One of the labels in {@link TASK_STATUSES}. */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Every task priority, in display order (lowest first). */
export const TASK_PRIORITIES = ['Low', 'Medium', 'High'] as const;

/** One of the labels in {@link TASK_PRIORITIES}. */
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Status given to a new task when none is submitted. */
export const DEFAULT_STATUS: TaskStatus = 'To do';

/** Priority given to a new task when none is submitted. */
export const DEFAULT_PRIORITY: TaskPriority = 'Medium';

/**
 * Statuses that count as open in the summary report. `Done` is never open.
 */
export const OPEN_STATUSES = ['To do', 'In progress'] as const satisfies readonly TaskStatus[];

/**
 * Reports whether `v` is exactly one of {@link TASK_STATUSES}.
 *
 * Matching is case-sensitive with no trimming, so `'done'` and `' Done'` are rejected. Callers
 * decide whether a rejection is an inline form error or a 400.
 */
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

/**
 * Reports whether `v` is exactly one of {@link TASK_PRIORITIES}.
 *
 * Matching is case-sensitive with no trimming, so `'high'` and `'Urgent'` are rejected. Callers
 * decide whether a rejection is an inline form error or a 400.
 */
export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v);
}

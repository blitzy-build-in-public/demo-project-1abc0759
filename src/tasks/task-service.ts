/**
 * Task service: one user's tasks created, read, edited, moved between statuses, deleted and
 * listed (FR-5 to FR-10).
 *
 * It orchestrates the pure rules in `./task-rules` and the owner-scoped tasks repository, and it
 * is the only task object the web layer receives. Owner scoping itself lives in the repository:
 * every call here passes the authenticated user's id straight through as `ownerId`, and no owner is
 * ever taken from task input. A missing task and another user's task therefore yield the same
 * `null` (or `false` for a delete), which the task routes turn into the identical 404
 * "Task not found.".
 *
 * Expected outcomes are values and nothing here throws on its own. Errors from the data-access
 * layer, `DatabaseUnavailableError` included, propagate unchanged to the web error handler. Input
 * is not validated here: `parseTaskForm` validates it in the web layer, and the table's `CHECK`
 * constraints are the backstop. Every timestamp comes from the injected clock.
 */

import type { DataAccess } from '../db/data-access';
import type { NewTaskRow, TaskId, TaskRecord, UserId } from '../db/types';
import type { Clock } from '../shared/clock';
import type { TaskStatus } from '../shared/task-values';
import { buildTaskUpdate, nextCompletedAt } from './task-rules';
import type { Task, TaskFilters, TaskInput, TaskListResult } from './types';

/**
 * Owner-scoped task operations for the web layer.
 *
 * Every method acts only on tasks owned by `ownerId`, which must be the authenticated user's id.
 * Methods that address one task return `null` (or `false`) when it does not exist or belongs to
 * another user, and never reveal which of the two applies.
 */
export interface TaskService {
  /**
   * Lists the owner's tasks matching the filters.
   *
   * @param ownerId - The authenticated user.
   * @param filters - Exact-match status and priority filters, combined with AND; an absent field
   *   does not filter.
   * @returns The matching tasks in repository order (due date soonest first, undated tasks last,
   *   then id), and `ownerHasTasks`, which drives the two empty states: `false` shows "You have no
   *   tasks yet." and `true` with no tasks shows "No tasks match these filters." The existence
   *   check runs only when no task matches; otherwise `ownerHasTasks` is `true`.
   */
  list(ownerId: UserId, filters: TaskFilters): Promise<TaskListResult>;

  /**
   * Reads one of the owner's tasks, without locking it.
   *
   * This is the owner-scoped existence lookup the web layer runs on every `:id` route before it
   * validates the body, so a missing or foreign task always yields the same 404.
   *
   * @param ownerId - The authenticated user.
   * @param taskId - The task's id.
   * @returns The task, or `null` when it does not exist or belongs to another user.
   */
  get(ownerId: UserId, taskId: TaskId): Promise<Task | null>;

  /**
   * Creates a task for the owner. `createdAt` and `updatedAt` are the clock's current instant, and
   * a task created as `Done` gets that instant as its completion time.
   *
   * @param ownerId - The authenticated user; the only source of the task's owner.
   * @param input - Validated field values, stored as given.
   * @returns The stored task with its generated id.
   */
  create(ownerId: UserId, input: TaskInput): Promise<Task>;

  /**
   * Replaces every editable field of one of the owner's tasks, inside one transaction that locks
   * the row. The completion time follows `nextCompletedAt`: set on entering `Done`, kept while the
   * task stays `Done`, cleared on leaving it. `updatedAt` becomes the clock's current instant.
   *
   * @param ownerId - The authenticated user.
   * @param taskId - The task's id.
   * @param input - Validated field values, stored as given.
   * @returns The updated task, or `null` when it does not exist or belongs to another user, in
   *   which case nothing is written.
   */
  update(ownerId: UserId, taskId: TaskId, input: TaskInput): Promise<Task | null>;

  /**
   * Moves one of the owner's tasks to `status` (the one-action status change), keeping its title,
   * description, priority and due date. It applies the same rules and row lock as
   * {@link TaskService.update}.
   *
   * @param ownerId - The authenticated user.
   * @param taskId - The task's id.
   * @param status - The new status, which may equal the current one.
   * @returns The updated task, or `null` when it does not exist or belongs to another user, in
   *   which case nothing is written.
   */
  changeStatus(ownerId: UserId, taskId: TaskId, status: TaskStatus): Promise<Task | null>;

  /**
   * Deletes one of the owner's tasks in a single owner-scoped statement.
   *
   * @param ownerId - The authenticated user.
   * @param taskId - The task's id.
   * @returns `true` when the task was deleted, `false` when it does not exist or belongs to
   *   another user.
   */
  delete(ownerId: UserId, taskId: TaskId): Promise<boolean>;
}

/** What {@link createTaskService} needs: the data-access facade and the source of the time. */
export interface TaskServiceDeps {
  /** The data-access facade; the service reaches task SQL only through its `tasks` repository. */
  dal: DataAccess;
  /** The only source of the current instant for every timestamp the service writes. */
  clock: Clock;
}

/**
 * Maps a stored record to the task callers receive. The fields are copied one by one so that the
 * owner id never leaves the service.
 */
function toTask(record: TaskRecord): Task {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    status: record.status,
    priority: record.priority,
    dueDate: record.dueDate,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

/**
 * Rewrites one of the owner's tasks inside one transaction: lock the row, derive the new field
 * values from the locked record, build the replacement row and write it.
 *
 * @param deps - The service's dependencies.
 * @param ownerId - The authenticated user.
 * @param taskId - The task's id.
 * @param inputFor - Derives the new field values from the task as currently stored.
 * @returns The updated task, or `null` when it does not exist or belongs to another user.
 */
function updateLocked(
  deps: TaskServiceDeps,
  ownerId: UserId,
  taskId: TaskId,
  inputFor: (current: TaskRecord) => TaskInput,
): Promise<Task | null> {
  return deps.dal.transaction(async (tx): Promise<Task | null> => {
    // `FOR UPDATE` serialises concurrent writes to one task, so `nextCompletedAt` always sees the
    // committed status: a concurrent edit that keeps a task `Done` cannot overwrite a completion
    // time recorded a moment earlier with a stale one.
    const current = await tx.tasks.findById(ownerId, taskId, { forUpdate: true });
    if (current === null) {
      return null;
    }
    // Read once, after the lock is held, so `updated_at` follows the order the writes commit in.
    const now = deps.clock.now();
    const row = buildTaskUpdate(current, inputFor(current), now);
    const updated = await tx.tasks.update(ownerId, taskId, row);
    return updated === null ? null : toTask(updated);
  });
}

/**
 * Creates the task service.
 *
 * @param deps - The data-access facade and the clock. The service holds no other state.
 * @returns The service, safe to share across concurrent requests.
 */
export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { dal, clock } = deps;

  return {
    async list(ownerId: UserId, filters: TaskFilters): Promise<TaskListResult> {
      const records = await dal.tasks.list(ownerId, filters);
      const ownerHasTasks = records.length > 0 ? true : await dal.tasks.exists(ownerId);
      return { tasks: records.map(toTask), ownerHasTasks };
    },

    async get(ownerId: UserId, taskId: TaskId): Promise<Task | null> {
      const record = await dal.tasks.findById(ownerId, taskId);
      return record === null ? null : toTask(record);
    },

    async create(ownerId: UserId, input: TaskInput): Promise<Task> {
      const now = clock.now();
      const row: NewTaskRow = {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate,
        createdAt: now,
        updatedAt: now,
        completedAt: nextCompletedAt(null, input.status, now),
      };
      return toTask(await dal.tasks.insert(ownerId, row));
    },

    update(ownerId: UserId, taskId: TaskId, input: TaskInput): Promise<Task | null> {
      return updateLocked(deps, ownerId, taskId, () => input);
    },

    changeStatus(ownerId: UserId, taskId: TaskId, status: TaskStatus): Promise<Task | null> {
      return updateLocked(
        deps,
        ownerId,
        taskId,
        (current): TaskInput => ({
          title: current.title,
          description: current.description,
          status,
          priority: current.priority,
          dueDate: current.dueDate,
        }),
      );
    },

    delete(ownerId: UserId, taskId: TaskId): Promise<boolean> {
      return dal.tasks.delete(ownerId, taskId);
    },
  };
}

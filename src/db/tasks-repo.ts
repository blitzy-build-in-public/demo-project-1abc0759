/**
 * Tasks repository: the only module that issues task SQL, including the report aggregates.
 *
 * Owner scoping lives here. Every function takes the owner's id as its first parameter, every
 * read, update, delete, existence check and aggregate filters on `owner_id = $1`, and the insert
 * binds `owner_id` to that parameter. No statement touches tasks without an owner, so another
 * user's task is never read into memory and looks exactly like a task that does not exist.
 *
 * Every statement is a constant string with bound parameters; values are never interpolated.
 * Connections run with the session time zone set to UTC (`src/db/pool.ts`), DATE values arrive as
 * `YYYY-MM-DD` text and INT8 values, `count(*)` included, as numbers.
 */

import { query } from './query';
import type { Queryable } from './query';
import type {
  DayCount,
  NewTaskRow,
  OpenTaskGroup,
  TaskId,
  TaskListFilters,
  TaskRecord,
  TaskUpdateRow,
  UserId,
} from './types';
import type { DateRange } from '../shared/dates';
import type { TaskPriority, TaskStatus } from '../shared/task-values';

/**
 * Owner-scoped access to the `tasks` table.
 *
 * Guarantee: every method is scoped to `ownerId`. Reads, updates, deletes, the existence check
 * and the aggregates filter on `owner_id = ownerId`, and `insert` binds `owner_id` to `ownerId`.
 * A missing task and another owner's task produce the same result (`null`, or `false` for
 * `delete`), so callers cannot tell them apart.
 */
export interface TasksRepo {
  /**
   * Stores a new task for `ownerId`.
   *
   * @param ownerId - The owning user; the only source of the `owner_id` column.
   * @param row - Every field of the task. Its timestamps come from the caller's `Clock`.
   * @returns The stored task with its generated id.
   */
  insert(ownerId: UserId, row: NewTaskRow): Promise<TaskRecord>;

  /**
   * Reads one of the owner's tasks.
   *
   * @param ownerId - The owning user.
   * @param taskId - The task's id.
   * @param opts - `forUpdate: true` locks the row (`FOR UPDATE`) until the surrounding
   *   transaction ends; it only has an effect on a client inside a transaction.
   * @returns The task, or `null` when it does not exist or belongs to another user.
   */
  findById(
    ownerId: UserId,
    taskId: TaskId,
    opts?: { forUpdate?: boolean },
  ): Promise<TaskRecord | null>;

  /**
   * Replaces every mutable field of one of the owner's tasks. `created_at` is never changed.
   *
   * @param ownerId - The owning user.
   * @param taskId - The task's id.
   * @param row - The new field values, `updatedAt` and `completedAt` included.
   * @returns The updated task, or `null` when it does not exist or belongs to another user.
   */
  update(ownerId: UserId, taskId: TaskId, row: TaskUpdateRow): Promise<TaskRecord | null>;

  /**
   * Deletes one of the owner's tasks.
   *
   * @param ownerId - The owning user.
   * @param taskId - The task's id.
   * @returns `true` when a task was deleted, `false` when it does not exist or belongs to another
   *   user.
   */
  delete(ownerId: UserId, taskId: TaskId): Promise<boolean>;

  /**
   * Lists the owner's tasks matching the filters, sorted by due date soonest first with undated
   * tasks last, then by id.
   *
   * @param ownerId - The owning user.
   * @param filters - Exact-match status and priority filters, combined with AND; an absent field
   *   does not filter.
   * @returns The matching tasks in list order, empty when none match.
   */
  list(ownerId: UserId, filters: TaskListFilters): Promise<TaskRecord[]>;

  /**
   * Tells whether the owner has any task at all, which separates the two empty list states.
   *
   * @param ownerId - The owning user.
   * @returns Whether at least one task belongs to the owner.
   */
  exists(ownerId: UserId): Promise<boolean>;

  /**
   * Counts the owner's open tasks (`To do` and `In progress`) grouped by status, priority and due
   * date. The overdue rule is applied to the groups by the report module, not here.
   *
   * @param ownerId - The owning user.
   * @returns One entry per distinct combination, in no particular order; empty with no open tasks.
   */
  openTaskGroups(ownerId: UserId): Promise<OpenTaskGroup[]>;

  /**
   * Counts the owner's tasks completed on each UTC day of an inclusive range.
   *
   * @param ownerId - The owning user.
   * @param range - Inclusive first and last day.
   * @returns One entry per day that has completions, in ascending day order. Days without
   *   completions have no entry.
   */
  completionsByDay(ownerId: UserId, range: DateRange): Promise<DayCount[]>;

  /**
   * Reads the owner's tasks created on any UTC day of an inclusive range, for the CSV export.
   *
   * @param ownerId - The owning user.
   * @param range - Inclusive first and last day of `created_at`.
   * @param status - Only tasks with exactly this status, or `null` for every status.
   * @returns The full task records, ordered by creation time and then id.
   */
  createdBetween(
    ownerId: UserId,
    range: DateRange,
    status: TaskStatus | null,
  ): Promise<TaskRecord[]>;
}

/** Column list selected and returned by every statement that yields full task rows. */
const TASK_COLUMNS =
  'id, owner_id, title, description, status, priority, due_date, created_at, updated_at, ' +
  'completed_at';

/**
 * A `tasks` row as `pg` returns it.
 *
 * `status` and `priority` are typed as the label unions because the table's `CHECK` lists admit
 * only those labels, so no other value can be read back.
 */
interface TaskRow {
  id: number;
  owner_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/**
 * A row of {@link OPEN_TASK_GROUPS_SQL}. `status` is never `Done`, which the statement's
 * `status <> 'Done'` predicate guarantees, and the `CHECK` lists bound both labels.
 */
interface OpenTaskGroupRow {
  status: Exclude<TaskStatus, 'Done'>;
  priority: TaskPriority;
  due_date: string | null;
  count: number;
}

/** A row of {@link COMPLETIONS_BY_DAY_SQL}. */
interface DayCountRow {
  day: string;
  count: number;
}

/** A row of {@link EXISTS_SQL}. */
interface ExistsRow {
  exists: boolean;
}

/** A row returned by {@link DELETE_SQL}. */
interface DeletedRow {
  id: number;
}

/** Maps a snake_case row to the camelCase record the layers above receive. */
function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * The SQL predicate selecting instants of `column` that fall on a UTC day from `$2` to `$3`, both
 * included, where `$2` and `$3` are bound to the range's `YYYY-MM-DD` strings.
 *
 * The bounds are built by PostgreSQL: `$2` at UTC midnight, inclusive, up to the UTC midnight of
 * the day after `$3`, exclusive. JavaScript never computes the day after `to`, which for
 * `9999-12-31` would be a five-digit year outside `IsoDate`; PostgreSQL's `date` represents
 * `9999-12-31 + 1` without trouble, and year `0001` works the same way.
 */
function utcDayRangePredicate(column: 'completed_at' | 'created_at'): string {
  return (
    `${column} >= ($2::date::timestamp AT TIME ZONE 'UTC') ` +
    `AND ${column} < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')`
  );
}

/** `$1` owner; the owner is never taken from the row. All timestamps are bound, never `now()`. */
const INSERT_SQL = `
  INSERT INTO tasks
    (owner_id, title, description, status, priority, due_date, created_at, updated_at,
     completed_at)
  VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9)
  RETURNING ${TASK_COLUMNS}`;

const FIND_BY_ID_SQL = `SELECT ${TASK_COLUMNS} FROM tasks WHERE owner_id = $1 AND id = $2`;

/** Appended to {@link FIND_BY_ID_SQL} to lock the row for the rest of the transaction. */
const FOR_UPDATE_SUFFIX = ' FOR UPDATE';

/** `created_at` is immutable, so it is absent from the SET list. */
const UPDATE_SQL = `
  UPDATE tasks
     SET title = $3, description = $4, status = $5, priority = $6,
         due_date = $7::date, updated_at = $8, completed_at = $9
   WHERE owner_id = $1 AND id = $2
  RETURNING ${TASK_COLUMNS}`;

const DELETE_SQL = 'DELETE FROM tasks WHERE owner_id = $1 AND id = $2 RETURNING id';

const EXISTS_SQL = 'SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = $1) AS exists';

/**
 * A `NULL` filter parameter disables that filter. The order equals `tasks_owner_due_idx
 * (owner_id, due_date ASC NULLS LAST, id)`, so the owner's rows are read in index order with the
 * filters as residual predicates, and the `id` tiebreak keeps equal due dates in a stable order.
 */
const LIST_SQL = `
  SELECT ${TASK_COLUMNS} FROM tasks
   WHERE owner_id = $1
     AND ($2::text IS NULL OR status = $2)
     AND ($3::text IS NULL OR priority = $3)
   ORDER BY due_date ASC NULLS LAST, id ASC`;

const OPEN_TASK_GROUPS_SQL = `
  SELECT status, priority, due_date, count(*) AS count
    FROM tasks
   WHERE owner_id = $1 AND status <> 'Done'
   GROUP BY status, priority, due_date`;

/**
 * Days are grouped by the UTC date of `completed_at`. The explicit `completed_at IS NOT NULL`
 * lets the planner use the partial index `tasks_owner_completed_idx`; reopened tasks have no
 * completion time and are not counted.
 */
const COMPLETIONS_BY_DAY_SQL = `
  SELECT to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS count
    FROM tasks
   WHERE owner_id = $1 AND completed_at IS NOT NULL
     AND ${utcDayRangePredicate('completed_at')}
   GROUP BY day
   ORDER BY day`;

/** Served by `tasks_owner_created_idx (owner_id, created_at, id)`, already in export order. */
const CREATED_BETWEEN_SQL = `
  SELECT ${TASK_COLUMNS} FROM tasks
   WHERE owner_id = $1 AND ${utcDayRangePredicate('created_at')}
     AND ($4::text IS NULL OR status = $4)
   ORDER BY created_at, id`;

/**
 * Creates the tasks repository on the pool, or on a client checked out for a transaction.
 *
 * Every method follows the owner-scoping guarantee of {@link TasksRepo}.
 *
 * @param db - Where the statements run. Row locks taken by `findById` with `forUpdate` last only
 *   while `db` is a client inside a transaction.
 * @returns The repository bound to `db`.
 */
export function createTasksRepo(db: Queryable): TasksRepo {
  return {
    async insert(ownerId: UserId, row: NewTaskRow): Promise<TaskRecord> {
      const rows = await query<TaskRow>(db, INSERT_SQL, [
        ownerId,
        row.title,
        row.description,
        row.status,
        row.priority,
        row.dueDate,
        row.createdAt,
        row.updatedAt,
        row.completedAt,
      ]);
      const inserted = rows[0];
      if (inserted === undefined) {
        throw new Error('Task insert returned no row');
      }
      return mapTask(inserted);
    },

    async findById(
      ownerId: UserId,
      taskId: TaskId,
      opts?: { forUpdate?: boolean },
    ): Promise<TaskRecord | null> {
      const sql = opts?.forUpdate === true ? FIND_BY_ID_SQL + FOR_UPDATE_SUFFIX : FIND_BY_ID_SQL;
      const rows = await query<TaskRow>(db, sql, [ownerId, taskId]);
      const found = rows[0];
      return found === undefined ? null : mapTask(found);
    },

    async update(
      ownerId: UserId,
      taskId: TaskId,
      row: TaskUpdateRow,
    ): Promise<TaskRecord | null> {
      const rows = await query<TaskRow>(db, UPDATE_SQL, [
        ownerId,
        taskId,
        row.title,
        row.description,
        row.status,
        row.priority,
        row.dueDate,
        row.updatedAt,
        row.completedAt,
      ]);
      const updated = rows[0];
      return updated === undefined ? null : mapTask(updated);
    },

    async delete(ownerId: UserId, taskId: TaskId): Promise<boolean> {
      const rows = await query<DeletedRow>(db, DELETE_SQL, [ownerId, taskId]);
      return rows.length > 0;
    },

    async list(ownerId: UserId, filters: TaskListFilters): Promise<TaskRecord[]> {
      const rows = await query<TaskRow>(db, LIST_SQL, [
        ownerId,
        filters.status ?? null,
        filters.priority ?? null,
      ]);
      return rows.map(mapTask);
    },

    async exists(ownerId: UserId): Promise<boolean> {
      const rows = await query<ExistsRow>(db, EXISTS_SQL, [ownerId]);
      return rows[0]?.exists === true;
    },

    async openTaskGroups(ownerId: UserId): Promise<OpenTaskGroup[]> {
      const rows = await query<OpenTaskGroupRow>(db, OPEN_TASK_GROUPS_SQL, [ownerId]);
      return rows.map(
        (row): OpenTaskGroup => ({
          status: row.status,
          priority: row.priority,
          dueDate: row.due_date,
          count: row.count,
        }),
      );
    },

    async completionsByDay(ownerId: UserId, range: DateRange): Promise<DayCount[]> {
      const rows = await query<DayCountRow>(db, COMPLETIONS_BY_DAY_SQL, [
        ownerId,
        range.from,
        range.to,
      ]);
      return rows.map((row): DayCount => ({ day: row.day, count: row.count }));
    },

    async createdBetween(
      ownerId: UserId,
      range: DateRange,
      status: TaskStatus | null,
    ): Promise<TaskRecord[]> {
      const rows = await query<TaskRow>(db, CREATED_BETWEEN_SQL, [
        ownerId,
        range.from,
        range.to,
        status,
      ]);
      return rows.map(mapTask);
    },
  };
}

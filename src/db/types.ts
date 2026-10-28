/**
 * Record types of the data-access layer.
 *
 * These are the camelCase shapes the repositories return and accept. Each repository keeps its own
 * private snake_case row interface and maps it to these records, so nothing above `src/db` sees a
 * column name. Every timestamp is an absolute UTC instant read from a `timestamptz(3)` column, and
 * every date-only value is `YYYY-MM-DD` text, never a `Date`.
 */

import type { IsoDate } from '../shared/dates';
import type { TaskPriority, TaskStatus } from '../shared/task-values';

/**
 * Identifier of a row in `users` (`bigint` identity).
 *
 * A `number` rather than a `bigint` or string: `src/db/pool.ts` registers an INT8 type parser that
 * returns `number`, which is exact because identity values stay far below 2^53.
 */
export type UserId = number;

/** Identifier of a row in `tasks` (`bigint` identity), a `number` as {@link UserId} explains. */
export type TaskId = number;

/**
 * The credentials needed to check a login, returned only by `UsersRepo.findCredentialsByEmail`.
 *
 * This is the only repository read result shape that carries the password hash, since no other
 * repository function selects `password_hash`. It must never reach the web layer, templates or
 * logs; `AuthenticatedUser` is the shape passed upward instead. {@link NewUserRow} also carries a
 * hash, but only as the insert input to `UsersRepo.insert`.
 */
export interface UserCredentials {
  /** The user's id. */
  id: UserId;
  /** The email as stored: trimmed, with its case as entered at sign-up. */
  email: string;
  /** The bcrypt hash (`$2b$12$…`). */
  passwordHash: string;
}

/** A new account, passed to `UsersRepo.insert`. */
export interface NewUserRow {
  /** The trimmed email, case preserved; uniqueness is enforced on `lower(email)`. */
  email: string;
  /** The bcrypt hash at cost 12; the plain-text password never reaches the data-access layer. */
  passwordHash: string;
  /** Creation instant, taken from the injected `Clock`. */
  createdAt: Date;
}

/**
 * A stored session joined to its user's email, returned by `SessionsRepo.touchIfActive`.
 *
 * `expiresAt` always equals `min(createdAt + absolute limit, lastActiveAt + idle limit)`, so the
 * session is active exactly while `now < expiresAt`.
 */
export interface SessionRecord {
  /** SHA-256 of the session token: 32 bytes, stored as `sessions.id bytea`. Never the raw token. */
  idHash: Buffer;
  /** Owner of the session. */
  userId: UserId;
  /** The owner's email as stored in `users`, read through the join. */
  userEmail: string;
  /** Instant the session was created at login. */
  createdAt: Date;
  /** Instant of the latest request on the session; never earlier than `createdAt`. */
  lastActiveAt: Date;
  /** Instant from which the session is expired; never later than `createdAt` plus 8 hours. */
  expiresAt: Date;
}

/** A new session row, passed to `SessionsRepo.insert`; the user's email is not a session column. */
export type NewSessionRow = Omit<SessionRecord, 'userEmail'>;

/**
 * Session lifetime limits passed to `SessionsRepo.touchIfActive`, in milliseconds.
 *
 * Callers pass `SESSION_ABSOLUTE_MS` and `SESSION_IDLE_MS` from `src/auth/session-policy.ts`, which
 * stays the single source of the limits; the repository holds no durations of its own.
 */
export interface SessionLimits {
  /** Maximum total age of a session, in milliseconds. */
  absoluteMs: number;
  /** Maximum time without activity, in milliseconds. */
  idleMs: number;
}

/**
 * A stored task, returned by the owner-scoped `TasksRepo` reads and writes.
 *
 * `completedAt` is set exactly when `status` is `Done`, which a table `CHECK` also enforces.
 */
export interface TaskRecord {
  /** The task's id. */
  id: TaskId;
  /** The owning user; every `TasksRepo` statement filters or binds on it. */
  ownerId: UserId;
  /** Trimmed title of 1 to 200 code points. */
  title: string;
  /** Description of up to 5,000 code points, `''` when absent, line breaks as submitted. */
  description: string;
  /** Current status label. */
  status: TaskStatus;
  /** Current priority label. */
  priority: TaskPriority;
  /** Due date as `YYYY-MM-DD` text, or `null` when the task has none. */
  dueDate: IsoDate | null;
  /** Creation instant. */
  createdAt: Date;
  /** Instant of the latest successful update; equal to `createdAt` until the first one. */
  updatedAt: Date;
  /** Instant the task last entered `Done`, or `null` while it is not `Done`. */
  completedAt: Date | null;
}

/**
 * A new task, passed to `TasksRepo.insert`.
 *
 * It has no owner field: the repository binds `owner_id` from its `ownerId` parameter, so the owner
 * can never come from form input.
 */
export type NewTaskRow = Omit<TaskRecord, 'id' | 'ownerId'>;

/**
 * The full replacement of a task's mutable fields, passed to `TasksRepo.update`.
 *
 * `createdAt` is immutable, and the id and owner select the row rather than being written.
 */
export type TaskUpdateRow = Omit<TaskRecord, 'id' | 'ownerId' | 'createdAt'>;

/**
 * A task's place in the list order `due_date ASC NULLS LAST, id ASC`, passed to
 * `TasksRepo.listNeighbour`: its due date, `null` for an undated task, and its id.
 */
export type TaskListKey = Pick<TaskRecord, 'dueDate' | 'id'>;

/**
 * Exact-match filters for `TasksRepo.list`. An absent field means no filter on that column, and the
 * two combine with AND.
 */
export interface TaskListFilters {
  /** Only tasks with exactly this status. */
  status?: TaskStatus;
  /** Only tasks with exactly this priority. */
  priority?: TaskPriority;
}

/**
 * The count of an owner's open tasks sharing one status, priority and due date, returned by
 * `TasksRepo.openTaskGroups` for the summary report, which applies the overdue rule per group.
 */
export interface OpenTaskGroup {
  /** An open status; `Done` tasks are never grouped. */
  status: Exclude<TaskStatus, 'Done'>;
  /** The group's priority. */
  priority: TaskPriority;
  /** The group's due date as `YYYY-MM-DD`, or `null` for undated tasks. */
  dueDate: IsoDate | null;
  /** Number of tasks in the group, always at least 1. */
  count: number;
}

/**
 * The number of an owner's tasks completed on one UTC day, returned by
 * `TasksRepo.completionsByDay`. Days with no completions have no entry; the report module fills
 * them with zeros.
 */
export interface DayCount {
  /** The UTC day of `completed_at`, as `YYYY-MM-DD`. */
  day: IsoDate;
  /** Number of tasks completed that day, always at least 1. */
  count: number;
}

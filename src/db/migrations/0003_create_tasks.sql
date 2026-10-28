-- Migration 0003_create_tasks
--
-- Creates the tasks table with its value checks and the three indexes that
-- match the task list, the completions report and the CSV export (plan
-- sections 0.5.2 and 0.5.3).
--
-- Owner scoping: every task statement in src/db/tasks-repo.ts filters on
-- owner_id, bound to the signed-in user's id, so every index below leads with
-- owner_id and each query reads only that owner's rows.
--
-- The migration runner (src/db/migrate.ts) applies this file exactly once,
-- inside a transaction it opens and closes itself, and records the version
-- in schema_migrations. The file therefore holds no transaction control.
--
-- Never edit this file once it has been applied anywhere. Later schema
-- changes go in new, higher-numbered migration files.

CREATE TABLE tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Deleting a user deletes their tasks.
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- char_length counts Unicode code points, the unit of TITLE_MAX_CHARS (200)
  -- and DESCRIPTION_MAX_CHARS (5000) that parseTaskForm checks first. These
  -- checks are the backstop.
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
  -- The labels must equal TASK_STATUSES and TASK_PRIORITIES in
  -- src/shared/task-values.ts character for character, because pages and the
  -- CSV show stored values unchanged. The defaults equal DEFAULT_STATUS and
  -- DEFAULT_PRIORITY; direct inserts in the test helpers and the perf seed
  -- rely on them.
  status text NOT NULL DEFAULT 'To do' CHECK (status IN ('To do', 'In progress', 'Done')),
  priority text NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High')),
  -- Date only. src/db/pool.ts parses DATE (OID 1082) as its YYYY-MM-DD text,
  -- so a due date never becomes a local-time JavaScript Date.
  due_date date,
  -- Millisecond precision matches JavaScript Date, so stored values equal the
  -- CSV's ISO 8601 output (for example 2026-10-21T09:15:30.123Z) exactly.
  -- No column has a database-clock default: the application binds every
  -- timestamp from its injected Clock.
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  completed_at timestamptz(3),
  -- A completion time exists exactly when the status is Done (nextCompletedAt
  -- in src/tasks/task-rules.ts sets it on entering Done and clears it on
  -- leaving).
  CONSTRAINT tasks_completed_at_check CHECK ((status = 'Done') = (completed_at IS NOT NULL))
);

-- Task list (TasksRepo.list): one owner's rows already in the list order,
-- due_date ASC NULLS LAST then id, with the status and priority filters as
-- residual predicates. Also serves TasksRepo.exists and the summary's scan
-- of open tasks (TasksRepo.openTaskGroups).
CREATE INDEX tasks_owner_due_idx ON tasks (owner_id, due_date ASC NULLS LAST, id);

-- Completions per UTC day (TasksRepo.completionsByDay): a completed_at range
-- scan for one owner. Partial because only completed tasks are counted; the
-- query repeats completed_at IS NOT NULL so the planner matches it.
CREATE INDEX tasks_owner_completed_idx ON tasks (owner_id, completed_at)
  WHERE completed_at IS NOT NULL;

-- CSV export (TasksRepo.createdBetween): a created_at range scan for one
-- owner, already in the export order created_at, id.
CREATE INDEX tasks_owner_created_idx ON tasks (owner_id, created_at, id);

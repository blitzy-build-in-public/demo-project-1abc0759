/**
 * Task routes: the task list, the new and edit forms, the one-action status change and the
 * delete with its no-JavaScript confirmation step (FR-5 to FR-10).
 *
 * Every route checks, in this order: the session (`requireAuth`), the CSRF token (`POST` only),
 * the `:id` path parameter (400), the owner-scoped existence lookup (404 "Task not found."), the
 * body or query (422 re-render, or 400 thrown), and only then the write. Handlers reach task data
 * only through the task service, never through a pool, repository or SQL, and they never render an
 * error page themselves: typed errors propagate to the error handler, which owns every failure
 * response.
 */

import express from 'express';
import type { Request, Response, Router } from 'express';

import type { AuthenticatedUser } from '../../auth/auth-service';
import { NotFoundError } from '../../shared/errors';
import { DEFAULT_PRIORITY, DEFAULT_STATUS } from '../../shared/task-values';
import type { TaskService } from '../../tasks/task-service';
import type { Task, TaskFilters, TaskId, UserId } from '../../tasks/types';
import { asyncHandler } from '../async-handler';
import { csrfTokenOf, type Csrf } from '../csrf';
import { requireAuth } from '../middleware/require-auth';
import '../request-user';
import {
  filtersToQuery,
  parseListFilters,
  parseStatusValue,
  parseTaskId,
  readField,
} from '../validation/params';
import { parseTaskForm, type TaskFormValues } from '../validation/task-form';
import {
  renderDeleteConfirmPage,
  renderTaskFormPage,
  renderTaskListPage,
} from '../templates/task-pages';

/** Field values of the new-task form before anything is entered: To do, Medium, no due date. */
const NEW_TASK_VALUES: Readonly<TaskFormValues> = {
  title: '',
  description: '',
  status: DEFAULT_STATUS,
  priority: DEFAULT_PRIORITY,
  dueDate: '',
};

/**
 * The signed-in user. Every handler here runs after `requireAuth`, so a missing user is a wiring
 * fault rather than anything a request can cause, and it surfaces as a 500.
 */
function currentUser(req: Request): AuthenticatedUser {
  const user = req.user;
  if (user === undefined) {
    throw new Error('requireAuth must run before task handlers');
  }
  return user;
}

/**
 * The task id from the `:id` path segment. Express types route parameters as an index signature,
 * which `noUncheckedIndexedAccess` widens with `undefined`; every route here declares `:id`, so
 * the empty-string fallback is unreachable and would still be rejected as 400.
 */
function taskIdOf(req: Request): TaskId {
  return parseTaskId(req.params.id ?? '');
}

/** Sends a complete HTML document with the given status. */
function sendHtml(res: Response, status: number, page: string): void {
  res.status(status).type('html').send(page);
}

/**
 * Reads one of the user's tasks through the owner-scoped lookup.
 *
 * A task that does not exist and a task owned by another user both come back as `null` and both
 * throw the same `NotFoundError`, so their 404 responses are byte-identical.
 *
 * @throws {@link NotFoundError} "Task not found." when the task is missing or foreign.
 */
async function loadOwnedTask(tasks: TaskService, userId: UserId, id: TaskId): Promise<Task> {
  const task = await tasks.get(userId, id);
  if (task === null) {
    throw new NotFoundError('Task not found.');
  }
  return task;
}

/**
 * The list filters echoed by the status-change and delete forms, so the redirect returns to the
 * same filtered list. An echo that was not posted sets no filter.
 *
 * @throws `BadRequestError` for an unknown label or a repeated field.
 */
function filterEchoes(body: unknown): TaskFilters {
  return parseListFilters({
    status: readField(body, 'filterStatus'),
    priority: readField(body, 'filterPriority'),
  });
}

/** The stored task as edit-form values; an undated task shows an empty due-date field. */
function toFormValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? '',
  };
}

/**
 * Creates the task router, mounted at the application root; it declares full paths and leaves
 * `GET /` to the application.
 *
 * Every route requires a session: without one, `GET` is redirected 302 to `/login?next=…` and
 * `POST` 303 to `/login?next=%2Ftasks`. Every `POST` then needs a session-bound CSRF token (403
 * otherwise), a malformed `:id` is 400 "Bad request.", and a missing or foreign task is 404
 * "Task not found.", identical in both cases.
 *
 * - `GET /tasks`: 200 list filtered by `status` and `priority` (each `''` or an exact label),
 *   with the two empty states; 400 for an unknown value or a repeated parameter.
 * - `GET /tasks/new`: 200 form preset to To do and Medium.
 * - `POST /tasks/new`: 303 to `/tasks`; 422 form with inline errors and the entered values, nothing
 *   saved.
 * - `GET /tasks/:id/edit`: 200 form with the stored values.
 * - `POST /tasks/:id/edit`: 303 to `/tasks`; 422 as for creation. A title submitted unchanged,
 *   its line breaks sent as CRLF, keeps the stored title exactly.
 * - `POST /tasks/:id/status`: moves the task to `status` (an exact label, else 400) and answers 303
 *   to `/tasks` with the echoed filters.
 * - `POST /tasks/:id/delete`: with `confirm=yes` deletes the task and answers 303 to `/tasks` with
 *   the echoed filters; otherwise 200 confirmation page and nothing changed.
 *
 * @param deps - The task service and the application's CSRF middleware.
 * @returns The router.
 */
export function createTaskRouter(deps: { tasks: TaskService; csrf: Csrf }): Router {
  const { tasks, csrf } = deps;
  // Exact matching, as the application sets for itself: a router does not inherit it, and
  // `/TASKS` or `/tasks/new/` must reach the 404 handler rather than a route.
  const router = express.Router({ caseSensitive: true, strict: true });
  // The session guard runs before the token check, so an unauthenticated POST is sent to the
  // login page rather than answered 403.
  const protectedPost = [requireAuth, csrf.verify('session')];

  router.get(
    '/tasks',
    requireAuth,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const query: unknown = req.query;
      const filters = parseListFilters(query);
      const result = await tasks.list(user.id, filters);
      sendHtml(
        res,
        200,
        renderTaskListPage({
          user,
          csrfToken: csrfTokenOf(res),
          tasks: result.tasks,
          ownerHasTasks: result.ownerHasTasks,
          filters,
        }),
      );
    }),
  );

  router.get('/tasks/new', requireAuth, (req, res): void => {
    sendHtml(
      res,
      200,
      renderTaskFormPage({
        user: currentUser(req),
        csrfToken: csrfTokenOf(res),
        mode: 'new',
        values: { ...NEW_TASK_VALUES },
        errors: {},
      }),
    );
  });

  router.post(
    '/tasks/new',
    protectedPost,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const body: unknown = req.body;
      const parsed = parseTaskForm(body);
      if (!parsed.ok) {
        sendHtml(
          res,
          422,
          renderTaskFormPage({
            user,
            csrfToken: csrfTokenOf(res),
            mode: 'new',
            values: parsed.values,
            errors: parsed.errors,
          }),
        );
        return;
      }
      await tasks.create(user.id, parsed.value);
      res.redirect(303, '/tasks');
    }),
  );

  router.get(
    '/tasks/:id/edit',
    requireAuth,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const id = taskIdOf(req);
      const task = await loadOwnedTask(tasks, user.id, id);
      sendHtml(
        res,
        200,
        renderTaskFormPage({
          user,
          csrfToken: csrfTokenOf(res),
          mode: 'edit',
          taskId: id,
          task,
          values: toFormValues(task),
          errors: {},
        }),
      );
    }),
  );

  router.post(
    '/tasks/:id/edit',
    protectedPost,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const id = taskIdOf(req);
      // The owner-scoped lookup runs before the body is parsed, so an invalid payload sent to a
      // missing or foreign task gets the same 404 as a valid one, never a 422 or 400 that would
      // reveal the task exists.
      const task = await loadOwnedTask(tasks, user.id, id);
      const body: unknown = req.body;
      // A browser submits every line break as CRLF, so the stored title lets the parser recognise
      // it unchanged and keep a lone CR or LF in it, rather than rewriting or lengthening it.
      const parsed = parseTaskForm(body, task.title);
      if (!parsed.ok) {
        sendHtml(
          res,
          422,
          renderTaskFormPage({
            user,
            csrfToken: csrfTokenOf(res),
            mode: 'edit',
            taskId: id,
            task,
            values: parsed.values,
            errors: parsed.errors,
          }),
        );
        return;
      }
      const updated = await tasks.update(user.id, id, parsed.value);
      // The task was deleted between the lookup and the locked update.
      if (updated === null) {
        throw new NotFoundError('Task not found.');
      }
      res.redirect(303, '/tasks');
    }),
  );

  router.post(
    '/tasks/:id/status',
    protectedPost,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const id = taskIdOf(req);
      // Existence first, as on every `:id` route: a malformed status sent to a missing or foreign
      // task is the same 404, not a 400.
      await loadOwnedTask(tasks, user.id, id);
      const body: unknown = req.body;
      const status = parseStatusValue(readField(body, 'status'));
      const filters = filterEchoes(body);
      const changed = await tasks.changeStatus(user.id, id, status);
      if (changed === null) {
        throw new NotFoundError('Task not found.');
      }
      res.redirect(303, `/tasks${filtersToQuery(filters)}`);
    }),
  );

  router.post(
    '/tasks/:id/delete',
    protectedPost,
    asyncHandler(async (req, res): Promise<void> => {
      const user = currentUser(req);
      const id = taskIdOf(req);
      // Existence first, as on every `:id` route, so the confirmation page is never shown for a
      // missing or foreign task.
      const task = await loadOwnedTask(tasks, user.id, id);
      const body: unknown = req.body;
      const filters = filterEchoes(body);
      const confirm = readField(body, 'confirm');
      if (confirm === 'yes') {
        const deleted = await tasks.delete(user.id, id);
        if (!deleted) {
          throw new NotFoundError('Task not found.');
        }
        res.redirect(303, `/tasks${filtersToQuery(filters)}`);
        return;
      }
      // No explicit confirmation: without JavaScript every Delete button arrives here, so the
      // server answers with the confirmation step and changes nothing. With JavaScript,
      // confirm-delete.js sets `confirm=yes` only after `window.confirm` returns OK.
      sendHtml(
        res,
        200,
        renderDeleteConfirmPage({ user, csrfToken: csrfTokenOf(res), task, filters }),
      );
    }),
  );

  return router;
}

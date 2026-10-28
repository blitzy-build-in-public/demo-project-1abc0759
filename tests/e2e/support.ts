/**
 * Shared browser helpers for the end-to-end specs: unique identities, sign-up and login through
 * the real forms, task creation through the task form, the task-list row locator, and the one
 * database read the specs compare pages and downloads with.
 *
 * Every helper except {@link userTasks} reaches the application only through the UI, exactly as a
 * user would, so a passing spec proves the pages themselves. Each test signs up its own user with
 * a `randomUUID()` email, so tests share no data and can run in parallel workers after the global
 * setup's single truncation.
 *
 * This file is not a spec: the `e2e` project matches `*.spec.ts` only.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type { TaskRecord } from '../../src/db/types';
import type { IsoDate } from '../../src/shared/dates';
import type { TaskPriority, TaskStatus } from '../../src/shared/task-values';
import { createTestPool, tasksForOwner, userIdByEmail } from '../helpers/test-db';

/** Where the server sends a successful login that carries no return path. */
const DEFAULT_RETURN_PATH = '/tasks';

/**
 * How long a submitted form may take to reach its redirect target. Sign-up and login each run one
 * cost-12 bcrypt operation on the server, which on a busy host can outlast the 5-second default of
 * `expect`; the specs' own 30-second test timeout still bounds the whole test.
 */
const SUBMIT_TIMEOUT_MS = 15_000;

/** Fixed base for parsing a return path into the pathname and search the browser will show. */
const PATH_BASE = 'http://return-path.invalid';

/**
 * Longest prefix that keeps the local part of {@link uniqueEmail} within the 64-character limit
 * of the email grammar: the prefix, a hyphen and a 36-character UUID.
 */
const MAX_EMAIL_PREFIX_CHARS = 27;

/** Prefixes {@link uniqueEmail} accepts: characters valid anywhere in an email local part. */
const EMAIL_PREFIX = new RegExp(`^[A-Za-z0-9-]{1,${MAX_EMAIL_PREFIX_CHARS}}$`);

/** Credentials of a user a spec signed up through the browser. */
export interface TestUser {
  /** The email exactly as submitted on the sign-up form. */
  email: string;
  /** The password exactly as submitted; never stored or shown by the application. */
  password: string;
}

/**
 * Returns an email no other test, worker or run has used: `<prefix>-<uuid>@example.test`.
 *
 * The address satisfies the sign-up grammar (its last domain label, `test`, has at least two
 * letters), and `example.test` is a reserved domain, so no mail can ever be delivered to it.
 *
 * @param prefix - Distinguishes the address in failure output, such as `'unknown'` for an email
 *   that is never signed up. Letters, digits and hyphens only, 1 to 27 characters.
 * @returns A fresh, lower-case email.
 * @throws Error when `prefix` is empty, too long or holds any other character.
 */
export function uniqueEmail(prefix = 'e2e'): string {
  if (!EMAIL_PREFIX.test(prefix)) {
    throw new Error(
      `uniqueEmail: prefix must be 1 to ${MAX_EMAIL_PREFIX_CHARS} letters, digits or hyphens`,
    );
  }
  return `${prefix}-${randomUUID()}@example.test`;
}

/**
 * Returns a fresh random password that meets the sign-up policy: 27 ASCII characters (inside the
 * 10-character minimum and the 72-byte maximum), with letters and a digit guaranteed by the fixed
 * `Pw` prefix and `7` suffix around 24 random hex digits.
 *
 * It is generated at run time, so no credential is committed.
 *
 * @returns The password.
 */
export function newPassword(): string {
  return `Pw${randomBytes(12).toString('hex')}7`;
}

/**
 * Clicks a form's submit button, then waits until the page's URL satisfies `isTarget` and the
 * target page has loaded, so a following `page.goto` never interrupts a navigation in flight.
 * A refused submission leaves the URL unchanged and fails with `failure`, which names the step,
 * together with the URL the page stayed on.
 */
async function submitAndWaitFor(
  page: Page,
  submit: Locator,
  isTarget: (url: URL) => boolean,
  failure: string,
): Promise<void> {
  await submit.click();
  await expect(page, failure).toHaveURL(isTarget, { timeout: SUBMIT_TIMEOUT_MS });
  await page.waitForLoadState('load');
}

/**
 * Signs up through `/signup`: opens the page, fills Email and Password, clicks "Create account"
 * and waits for the login page with the account-created notice, `/login?created=1`.
 *
 * The page must be signed out, because a signed-in browser is redirected away from `/signup`.
 *
 * @param page - A signed-out page.
 * @param email - The email to register; it must not have an account yet.
 * @param password - A password that meets the sign-up policy.
 * @throws When the form is refused (an invalid field or an existing account), so the page never
 *   reaches `/login?created=1`.
 */
export async function signUp(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/signup');
  const form = page.locator('form[action="/signup"]');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await submitAndWaitFor(
    page,
    form.getByRole('button', { name: 'Create account', exact: true }),
    (u) => u.pathname === '/login' && u.search === '?created=1',
    `signUp: the sign-up form was not accepted for ${email}`,
  );
}

/**
 * Logs in through `/login`: fills Email and Password, clicks "Log in" and waits for the return
 * path, `next` when given and `/tasks` otherwise.
 *
 * A page already on `/login` whose `next` query value equals `next` (or that has none when `next`
 * is omitted), such as `/login?created=1` after {@link signUp} or `/login?next=%2Ftasks` after
 * the auth guard's redirect, is used as it stands, because its hidden `next` field already holds
 * that return path. Any other page first navigates to `/login`, adding `?next=<encoded next>`
 * when `next` is given.
 *
 * @param page - A signed-out page.
 * @param email - The account's email, in any case.
 * @param password - The account's password.
 * @param next - A same-origin path the server accepts as a return path, such as `/reports` or
 *   `/tasks?status=Done`. The helper waits for exactly this path and query, so a value the
 *   server would replace with `/tasks` fails rather than passing unnoticed.
 * @throws Error when `next` targets `/login` itself, which the server never returns to after a
 *   login. Also throws when the login is refused (invalid credentials or a lockout), so the page
 *   never reaches the return path.
 */
export async function logIn(
  page: Page,
  email: string,
  password: string,
  next?: string,
): Promise<void> {
  const target = new URL(next ?? DEFAULT_RETURN_PATH, PATH_BASE);
  // The submission starts on /login, so a /login target would match before the login happened.
  if (target.pathname === '/login') {
    throw new Error('logIn: next cannot be /login; the server never returns there after a login');
  }
  const current = new URL(page.url());
  const onMatchingLoginPage =
    current.pathname === '/login' && current.searchParams.get('next') === (next ?? null);
  if (!onMatchingLoginPage) {
    await page.goto(next === undefined ? '/login' : `/login?next=${encodeURIComponent(next)}`);
  }
  const form = page.locator('form[action="/login"]');
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await submitAndWaitFor(
    page,
    form.getByRole('button', { name: 'Log in', exact: true }),
    (u) => u.pathname === target.pathname && u.search === target.search,
    `logIn: the login for ${email} did not reach ${target.pathname}${target.search}`,
  );
}

/**
 * Signs up a brand-new user with {@link uniqueEmail} and {@link newPassword}, then logs in, leaving
 * the page on `/tasks`. Every call creates a different user, which is what isolates one test's
 * data from every other test and worker.
 *
 * @param page - A signed-out page.
 * @returns The new user's credentials, for later logins and {@link userTasks}.
 */
export async function signUpAndLogIn(page: Page): Promise<TestUser> {
  const user: TestUser = { email: uniqueEmail(), password: newPassword() };
  await signUp(page, user.email, user.password);
  await logIn(page, user.email, user.password);
  return user;
}

/** Field values {@link createTask} enters on the new-task form. */
export interface NewTaskFields {
  /** Title, 1 to 200 code points after trimming. */
  title: string;
  /** Description; left empty when omitted. Typed line feeds are submitted as CRLF. */
  description?: string;
  /** Status; the form's default, `To do`, when omitted. */
  status?: TaskStatus;
  /** Priority; the form's default, `Medium`, when omitted. */
  priority?: TaskPriority;
  /** Due date as `YYYY-MM-DD`; no due date when omitted. */
  dueDate?: IsoDate;
}

/**
 * Creates a task through `/tasks/new`: fills Title, and Description, Status, Priority and Due
 * date when given, clicks "Save" and waits for the task list, `/tasks`. Omitted fields keep the
 * form's defaults (`To do`, `Medium`, no description, no due date).
 *
 * @param page - A signed-in page.
 * @param fields - The values to enter; each must pass the task form's validation.
 * @throws When the form is refused with inline errors, so the page never reaches `/tasks`.
 */
export async function createTask(page: Page, fields: NewTaskFields): Promise<void> {
  await page.goto('/tasks/new');
  const form = page.locator('form[action="/tasks/new"]');
  await form.getByLabel('Title', { exact: true }).fill(fields.title);
  if (fields.description !== undefined) {
    await form.getByLabel('Description', { exact: true }).fill(fields.description);
  }
  // Option values are the labels themselves, such as 'In progress'.
  if (fields.status !== undefined) {
    await form.getByLabel('Status', { exact: true }).selectOption(fields.status);
  }
  if (fields.priority !== undefined) {
    await form.getByLabel('Priority', { exact: true }).selectOption(fields.priority);
  }
  if (fields.dueDate !== undefined) {
    // `fill` sets a `type="date"` control from its `YYYY-MM-DD` value.
    await form.getByLabel('Due date', { exact: true }).fill(fields.dueDate);
  }
  await submitAndWaitFor(
    page,
    form.getByRole('button', { name: 'Save', exact: true }),
    (u) => u.pathname === '/tasks',
    `createTask: the new-task form was not accepted for "${fields.title}"`,
  );
}

/**
 * Locates the task-list rows whose title link is named exactly `title`. The title cell links to
 * the task's edit page, so the match never reaches the status or priority cells.
 *
 * Callers assert `toHaveCount(1)` for a listed task and `toHaveCount(0)` for one that is gone,
 * so titles must be unique within a test. Accessible names collapse runs of whitespace, so a
 * title should hold none.
 *
 * @param page - A page showing the task list.
 * @param title - The stored, trimmed title.
 * @returns A locator for the matching `table tbody tr` rows.
 */
export function taskRow(page: Page, title: string): Locator {
  return page
    .locator('table tbody tr')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) });
}

/**
 * Reads every task of the user with `email` straight from the test database: the truth that
 * pages and CSV downloads are compared with. It never writes.
 *
 * Rows are `TaskRecord`-shaped (`id` a number, `dueDate` `YYYY-MM-DD` text or `null`, `createdAt`
 * a `Date`, `completedAt` a `Date` or `null`) and ordered by `created_at, id`, the CSV export
 * order. Stored text is exactly what the browser submitted, which is not always what a test
 * typed: a `<textarea>` submission turns every line break into CRLF, so compare an export with
 * these rows rather than with the typed input.
 *
 * Playwright workers inherit `DATABASE_URL` from the runner; the pool refuses any database whose
 * name does not end in `_test`, and it is closed before the call returns, so no connection
 * outlives the call.
 *
 * @param email - The user's email, in any case.
 * @returns The user's tasks, empty when there are none.
 * @throws Error when no user has that email, or the `_test` guard's error for `DATABASE_URL`.
 */
export async function userTasks(email: string): Promise<TaskRecord[]> {
  const pool = createTestPool();
  try {
    const ownerId = await userIdByEmail(pool, email);
    if (ownerId === null) {
      throw new Error(`userTasks: no user has the email ${email}`);
    }
    return await tasksForOwner(pool, ownerId);
  } finally {
    await pool.end();
  }
}

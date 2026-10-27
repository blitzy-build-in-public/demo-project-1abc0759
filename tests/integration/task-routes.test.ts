/**
 * Integration tests for the task routes over real HTTP against real PostgreSQL 16: create, edit,
 * one-action status change and delete (SC4), the completion time (SC5), list filters, sort and
 * empty states (SC6), owner isolation with identical 404s (SC7), and the validation, malformed,
 * unauthenticated, CSRF and caching states (SC11).
 *
 * Every request goes through the in-process production stack with a `FakeClock`. Pages are
 * compared with the rows read straight from the `tasks` table. Clock moves stay well inside the
 * 30-minute idle limit, so the signed-in sessions never expire mid-test.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import type { HttpClient, HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import {
  countRows,
  createTestPool,
  insertTask,
  sql,
  tasksForOwner,
  truncateAll,
  userIdByEmail,
} from '../helpers/test-db';

/** The running application, as `startTestApp` returns it. */
type TestApp = Awaited<ReturnType<typeof startTestApp>>;

/** The test pool, as `createTestPool` returns it. */
type Pool = ReturnType<typeof createTestPool>;

/** One stored task, read straight from the table. */
type TaskRow = Awaited<ReturnType<typeof tasksForOwner>>[number];

/** Field values accepted by `insertTask`. */
type TaskFixture = NonNullable<Parameters<typeof insertTask>[2]>;

/** Fields of a URL-encoded form; an array value is sent as a repeated parameter. */
type FormFields = Readonly<Record<string, string | string[]>>;

/** A signed-up, logged-in user with their own cookie jar. */
interface User {
  client: HttpClient;
  email: string;
  userId: number;
  /**
   * The session-bound CSRF token from the user's task list. It stays valid for the whole test,
   * because neither the session nor the nonce cookie changes. It is passed explicitly, since an
   * error page carries no token for the client to pick up.
   */
  csrf: string;
}

/** Added to an existing id to get a well-formed id that no task has. */
const MISSING_ID_OFFSET = 100_000;

/** Shown in the due-date column of an undated task. */
const NO_DUE_DATE = '\u2014';

/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const EMOJI = '\u{1F600}';

const TASK_NOT_FOUND = 'Task not found.';
const BAD_REQUEST = 'Bad request.';
const FORM_EXPIRED = 'The form has expired. Reload the page and try again.';
const TITLE_REQUIRED = 'Title is required.';
const TITLE_TOO_LONG = 'Title must be at most 200 characters.';
const DESCRIPTION_TOO_LONG = 'Description must be at most 5,000 characters.';
const INVALID_DATE = 'Enter a valid date (YYYY-MM-DD).';
const INVALID_STATUS = 'Choose a valid status.';
const INVALID_PRIORITY = 'Choose a valid priority.';

/** A task title link on the list page; the row buttons post to `/status` and `/delete` instead. */
const TITLE_LINK = /href="\/tasks\/(\d+)\/edit"/g;

/** One step of the clock between requests: one minute, far inside the idle limit. */
const STEP_MS = 60_000;

let app: TestApp;
let pool: Pool;
const clock = new FakeClock();
let userA: User;

/**
 * Signs up a new account with a unique email and a policy-compliant random password, then logs
 * in with it on the same client.
 */
async function signUpAndLogIn(client: HttpClient): Promise<{ email: string; userId: number }> {
  const email = `user-${randomUUID()}@example.com`;
  // The fixed prefix guarantees a letter and a digit whatever the random hex holds.
  const password = `Pw1-${randomBytes(12).toString('hex')}`;

  expect((await client.get('/signup')).status).toBe(200);
  const signUp = await client.post('/signup', { email, password });
  expect(signUp.status).toBe(303);

  expect((await client.get('/login')).status).toBe(200);
  const logIn = await client.post('/login', { email, password });
  expect(logIn.status).toBe(303);
  expect(logIn.location).toBe('/tasks');

  const userId = await userIdByEmail(pool, email);
  if (userId === null) {
    throw new Error('signUpAndLogIn: the new account was not stored');
  }
  return { email, userId };
}

/** Creates, signs up and logs in a user on a fresh client and captures their CSRF token. */
async function newUser(): Promise<User> {
  const client = app.client();
  const { email, userId } = await signUpAndLogIn(client);
  const list = await client.get('/tasks');
  expect(list.status).toBe(200);
  const csrf = client.csrfToken();
  if (csrf === null) {
    throw new Error('newUser: the task list carries no CSRF token');
  }
  return { client, email, userId, csrf };
}

/** Posts a form as `user` with their session-bound CSRF token. */
function postAs(user: User, path: string, fields: FormFields): Promise<HttpResult> {
  return user.client.post(path, { ...fields }, { csrf: user.csrf });
}

/** Loads the new-task form, which refreshes the client's CSRF token, then submits it. */
async function createViaForm(client: HttpClient, fields: FormFields): Promise<HttpResult> {
  const form = await client.get('/tasks/new');
  expect(form.status).toBe(200);
  return client.post('/tasks/new', { ...fields });
}

/** The task ids of a list page, in page order, read from the title links. */
function listIds(body: string): number[] {
  const ids: number[] = [];
  for (const match of body.matchAll(TITLE_LINK)) {
    const id = match[1];
    if (id === undefined) {
      throw new Error('listIds: a title link without an id');
    }
    ids.push(Number(id));
  }
  return ids;
}

/** The markup of the list row whose title links to task `id`. */
function rowFor(body: string, id: number): string {
  const link = `href="/tasks/${id}/edit"`;
  const chunk = body.split('<tr').find((part) => part.includes(link));
  if (chunk === undefined) {
    throw new Error(`rowFor: the list has no row for task ${id}`);
  }
  const end = chunk.indexOf('</tr>');
  return end < 0 ? chunk : chunk.slice(0, end);
}

/** The stored task with `id` among the owner's tasks. */
async function storedTask(ownerId: number, id: number): Promise<TaskRow> {
  const task = (await tasksForOwner(pool, ownerId)).find((t) => t.id === id);
  if (task === undefined) {
    throw new Error(`storedTask: task ${id} is not stored for owner ${ownerId}`);
  }
  return task;
}

/** The owner's only stored task. */
async function onlyTask(ownerId: number): Promise<TaskRow> {
  const tasks = await tasksForOwner(pool, ownerId);
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  if (task === undefined) {
    throw new Error('onlyTask: no task stored');
  }
  return task;
}

/** A stored task as the edit form submits it unchanged. */
function formFieldsOf(task: TaskRow): Record<string, string> {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? '',
  };
}

/**
 * Asserts that a list page shows exactly the owner's stored tasks in list order, each row with
 * its stored title, status, priority and due date (or an em dash when undated).
 */
async function expectListShowsStored(body: string, ownerId: number): Promise<void> {
  const stored = await tasksForOwner(pool, ownerId, 'due');
  expect(listIds(body)).toEqual(stored.map((t) => t.id));
  for (const task of stored) {
    const row = rowFor(body, task.id);
    expect(row).toContain(`>${task.title}</a>`);
    expect(row).toContain(`<td>${task.status}</td>`);
    expect(row).toContain(`<td>${task.priority}</td>`);
    expect(row).toContain(`<td>${task.dueDate ?? NO_DUE_DATE}</td>`);
  }
}

/** Asserts a fixed-message error page: its status and its message. */
function expectErrorPage(res: HttpResult, status: number, message: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toContain(`<p>${message}</p>`);
}

/** Asserts an inline message beside one field of a re-rendered task form. */
function expectFieldError(res: HttpResult, field: string, message: string): void {
  expect(res.body).toContain(`id="${field}-error">${message}</p>`);
}

beforeAll(async () => {
  app = await startTestApp({ clock });
  pool = createTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  clock.set(FAKE_CLOCK_START);
  userA = await newUser();
});

afterAll(async () => {
  // Guarded so that a failed start reports its own error rather than a TypeError here.
  await app?.close();
  await pool?.end();
});

describe('create, edit, change status and delete (SC4)', () => {
  test('each step is reflected in the next task list and in the database', async () => {
    const client = userA.client;

    const created = await createViaForm(client, {
      title: 'Write report',
      description: '',
      status: 'To do',
      priority: 'Medium',
      dueDate: '',
    });
    expect(created.status).toBe(303);
    expect(created.location).toBe('/tasks');
    expect(
      (await createViaForm(client, { title: 'Plan trip', description: '', dueDate: '' })).status,
    ).toBe(303);

    let page = await client.get('/tasks');
    expect(page.status).toBe(200);
    expect(page.body).toContain('>Write report</a>');
    await expectListShowsStored(page.body, userA.userId);
    const report = (await tasksForOwner(pool, userA.userId)).find(
      (t) => t.title === 'Write report',
    );
    if (report === undefined) {
      throw new Error('the created task was not stored');
    }
    expect(report).toMatchObject({
      description: '',
      status: 'To do',
      priority: 'Medium',
      dueDate: null,
      completedAt: null,
    });
    expect(rowFor(page.body, report.id)).toContain(`<td>${NO_DUE_DATE}</td>`);

    const edited = await postAs(userA, `/tasks/${report.id}/edit`, {
      title: 'Write final report',
      description: 'Include the appendix',
      status: 'To do',
      priority: 'High',
      dueDate: '2026-11-05',
    });
    expect(edited.status).toBe(303);
    expect(edited.location).toBe('/tasks');
    page = await client.get('/tasks');
    const editedRow = rowFor(page.body, report.id);
    expect(editedRow).toContain('>Write final report</a>');
    expect(editedRow).toContain('<td>High</td>');
    expect(editedRow).toContain('<td>2026-11-05</td>');
    expect(page.body).not.toContain('>Write report</a>');
    await expectListShowsStored(page.body, userA.userId);
    expect(await storedTask(userA.userId, report.id)).toMatchObject({
      title: 'Write final report',
      description: 'Include the appendix',
      status: 'To do',
      priority: 'High',
      dueDate: '2026-11-05',
    });

    const moved = await postAs(userA, `/tasks/${report.id}/status`, {
      status: 'In progress',
      filterStatus: '',
      filterPriority: '',
    });
    expect(moved.status).toBe(303);
    expect(moved.location).toBe('/tasks');
    page = await client.get('/tasks');
    const movedRow = rowFor(page.body, report.id);
    expect(movedRow).toContain('<td>In progress</td>');
    expect(movedRow).toContain('>Mark To do</button>');
    expect(movedRow).toContain('>Mark Done</button>');
    expect(movedRow).not.toContain('Mark In progress');
    await expectListShowsStored(page.body, userA.userId);
    expect((await storedTask(userA.userId, report.id)).status).toBe('In progress');

    const deleted = await postAs(userA, `/tasks/${report.id}/delete`, {
      confirm: 'yes',
      filterStatus: '',
      filterPriority: '',
    });
    expect(deleted.status).toBe(303);
    expect(deleted.location).toBe('/tasks');
    page = await client.get('/tasks');
    expect(listIds(page.body)).not.toContain(report.id);
    expect(page.body).not.toContain('Write final report');
    await expectListShowsStored(page.body, userA.userId);
    expect((await tasksForOwner(pool, userA.userId)).map((t) => t.title)).toEqual(['Plan trip']);
  });
});

describe('completion time (SC5)', () => {
  test('moving into Done records the time and moving out of Done clears it', async () => {
    const task = await insertTask(pool, userA.userId, { title: 'Ship it', status: 'To do' });

    clock.advance(STEP_MS);
    const c1 = clock.now();
    expect((await postAs(userA, `/tasks/${task.id}/status`, { status: 'Done' })).status).toBe(303);
    const done = await storedTask(userA.userId, task.id);
    expect(done.status).toBe('Done');
    expect(done.completedAt?.getTime()).toBe(c1.getTime());

    clock.advance(STEP_MS);
    const c2 = clock.now();
    expect(
      (await postAs(userA, `/tasks/${task.id}/status`, { status: 'In progress' })).status,
    ).toBe(303);
    const reopened = await storedTask(userA.userId, task.id);
    expect(reopened.status).toBe('In progress');
    expect(reopened.completedAt).toBeNull();
    expect(reopened.updatedAt.getTime()).toBe(c2.getTime());
  });

  test('editing a Done task keeps its completion time and moves the update time', async () => {
    const task = await insertTask(pool, userA.userId, { title: 'Close sprint', status: 'To do' });

    clock.advance(STEP_MS);
    const c3 = clock.now();
    expect((await postAs(userA, `/tasks/${task.id}/status`, { status: 'Done' })).status).toBe(303);
    const done = await storedTask(userA.userId, task.id);

    clock.advance(STEP_MS);
    const c4 = clock.now();
    const edit = await postAs(userA, `/tasks/${task.id}/edit`, {
      ...formFieldsOf(done),
      title: 'Close the sprint',
    });
    expect(edit.status).toBe(303);
    const after = await storedTask(userA.userId, task.id);
    expect(after.title).toBe('Close the sprint');
    expect(after.status).toBe('Done');
    expect(after.completedAt?.getTime()).toBe(c3.getTime());
    expect(after.updatedAt.getTime()).toBe(c4.getTime());
  });

  test('creating a task as Done records the creation time as its completion time', async () => {
    clock.advance(STEP_MS);
    const c5 = clock.now();
    const created = await createViaForm(userA.client, { title: 'Already done', status: 'Done' });
    expect(created.status).toBe(303);
    const task = await onlyTask(userA.userId);
    expect(task.status).toBe('Done');
    expect(task.completedAt?.getTime()).toBe(c5.getTime());
    expect(task.createdAt.getTime()).toBe(c5.getTime());
    expect(task.updatedAt.getTime()).toBe(c5.getTime());
  });

  test.each<{ status: TaskRow['status'] }>([
    { status: 'Done' },
    { status: 'In progress' },
    { status: 'To do' },
  ])(
    'a priority-only edit in status $status keeps the status and the completion time',
    async ({ status }) => {
      const original = await insertTask(pool, userA.userId, {
        title: 'Reprioritise',
        status,
        priority: 'Medium',
      });

      clock.advance(STEP_MS);
      const at = clock.now();
      const edit = await postAs(userA, `/tasks/${original.id}/edit`, {
        ...formFieldsOf(original),
        priority: 'Low',
      });
      expect(edit.status).toBe(303);
      const after = await storedTask(userA.userId, original.id);
      expect(after.priority).toBe('Low');
      expect(after.status).toBe(status);
      expect(after.completedAt).toEqual(original.completedAt);
      expect(after.updatedAt.getTime()).toBe(at.getTime());
    },
  );
});

describe('task form defaults', () => {
  test('the new-task form preselects To do and Medium', async () => {
    const form = await userA.client.get('/tasks/new');
    expect(form.status).toBe(200);
    expect(form.body).toMatch(/<option[^>]*value="To do"[^>]*selected/);
    expect(form.body).toMatch(/<option[^>]*value="Medium"[^>]*selected/);
    expect(form.body).not.toMatch(/<option[^>]*value="(In progress|Done|Low|High)"[^>]*selected/);
  });

  test('a form with only a title stores the defaults', async () => {
    const created = await createViaForm(userA.client, { title: 'Only a title' });
    expect(created.status).toBe(303);
    expect(await onlyTask(userA.userId)).toMatchObject({
      title: 'Only a title',
      description: '',
      status: 'To do',
      priority: 'Medium',
      dueDate: null,
      completedAt: null,
    });
  });

  test('the title is stored trimmed and the description exactly as submitted', async () => {
    const description = '  First line\r\nSecond line\n\nThird line  ';
    const created = await createViaForm(userA.client, { title: '  Spaced  ', description });
    expect(created.status).toBe(303);
    const task = await onlyTask(userA.userId);
    expect(task.title).toBe('Spaced');
    expect(task.description).toBe(description);
  });
});

/** One invalid task-form submission: the offending field, its value and the inline message. */
interface InvalidFormCase {
  name: string;
  field: 'title' | 'description' | 'status' | 'priority' | 'dueDate';
  value: string;
  message: string;
  /** Markup the re-rendered form must hold to keep the entered value visible, if any. */
  rendered: RegExp | null;
}

const INVALID_FORM_CASES: readonly InvalidFormCase[] = [
  { name: 'an empty title', field: 'title', value: '', message: TITLE_REQUIRED, rendered: null },
  {
    name: 'a whitespace-only title',
    field: 'title',
    value: '   ',
    message: TITLE_REQUIRED,
    rendered: null,
  },
  {
    name: 'a 201-character title',
    field: 'title',
    value: 'a'.repeat(201),
    message: TITLE_TOO_LONG,
    rendered: null,
  },
  {
    name: 'a 5001-character description',
    field: 'description',
    value: 'd'.repeat(5001),
    message: DESCRIPTION_TOO_LONG,
    rendered: null,
  },
  {
    name: 'an impossible due date',
    field: 'dueDate',
    value: '2026-02-30',
    message: INVALID_DATE,
    // A browser empties an invalid value in a type=date control, so it comes back as text.
    rendered: new RegExp(
      '<input(?=[^>]*\\stype="text")(?=[^>]*\\sname="dueDate")' +
        '(?=[^>]*\\svalue="2026-02-30")[^>]*>',
    ),
  },
  {
    name: 'an unknown status',
    field: 'status',
    value: 'Blocked',
    message: INVALID_STATUS,
    rendered: /<option[^>]*value="Blocked"[^>]*selected[^>]*>Blocked \(invalid\)<\/option>/,
  },
  {
    name: 'an unknown priority',
    field: 'priority',
    value: 'Urgent',
    message: INVALID_PRIORITY,
    rendered: /<option[^>]*value="Urgent"[^>]*selected[^>]*>Urgent \(invalid\)<\/option>/,
  },
];

/** Asserts a 422 re-render with the case's message beside its field and its kept value. */
function expectInvalidForm(res: HttpResult, c: InvalidFormCase): void {
  expect(res.status).toBe(422);
  expectFieldError(res, c.field, c.message);
  if (c.rendered !== null) {
    expect(res.body).toMatch(c.rendered);
  }
}

describe('task form validation (422, nothing saved)', () => {
  test.each(INVALID_FORM_CASES)('creating with $name is refused', async (c) => {
    const before = await countRows(pool, 'tasks');
    const res = await createViaForm(userA.client, { title: 'Valid title', [c.field]: c.value });
    expectInvalidForm(res, c);
    expect(await countRows(pool, 'tasks')).toBe(before);
  });

  test.each(INVALID_FORM_CASES)('editing with $name is refused', async (c) => {
    const original = await insertTask(pool, userA.userId, {
      title: 'Original title',
      description: 'Original description',
      status: 'In progress',
      priority: 'Low',
      dueDate: '2026-11-15',
    });
    const before = await tasksForOwner(pool, userA.userId);
    const res = await postAs(userA, `/tasks/${original.id}/edit`, {
      ...formFieldsOf(original),
      [c.field]: c.value,
    });
    expectInvalidForm(res, c);
    expect(await tasksForOwner(pool, userA.userId)).toEqual(before);
  });

  test('a refused form keeps the entered description with its line breaks', async () => {
    const res = await createViaForm(userA.client, {
      title: '',
      description: 'Line one\nLine two',
    });
    expect(res.status).toBe(422);
    expectFieldError(res, 'title', TITLE_REQUIRED);
    expect(res.body).toContain('Line one\nLine two</textarea>');
    expect(await countRows(pool, 'tasks')).toBe(0);
  });

  test('a refused form re-renders an entered title escaped', async () => {
    const res = await createViaForm(userA.client, {
      title: '<script>x</script>',
      dueDate: '2026-13-01',
    });
    expect(res.status).toBe(422);
    expectFieldError(res, 'dueDate', INVALID_DATE);
    expect(res.body).toContain('value="&lt;script&gt;x&lt;/script&gt;"');
    expect(res.body).not.toContain('<script>x');
    expect(await countRows(pool, 'tasks')).toBe(0);
  });
});

describe('code-point length limits', () => {
  test.each<{ name: string; field: 'title' | 'description'; value: string }>([
    {
      name: 'a 200-code-point title of 300 UTF-16 units',
      field: 'title',
      value: EMOJI.repeat(100) + 'a'.repeat(100),
    },
    {
      name: 'a 5000-code-point description holding emoji',
      field: 'description',
      value: EMOJI.repeat(2500) + 'b'.repeat(2500),
    },
  ])('$name is accepted and stored exactly', async ({ field, value }) => {
    const res = await createViaForm(userA.client, { title: 'Boundary', [field]: value });
    expect(res.status).toBe(303);
    expect((await onlyTask(userA.userId))[field]).toBe(value);
  });

  test.each<{ name: string; field: 'title' | 'description'; value: string; message: string }>([
    {
      name: 'a 201-code-point title',
      field: 'title',
      value: EMOJI.repeat(100) + 'a'.repeat(101),
      message: TITLE_TOO_LONG,
    },
    {
      name: 'a 5001-code-point description',
      field: 'description',
      value: EMOJI.repeat(2500) + 'b'.repeat(2501),
      message: DESCRIPTION_TOO_LONG,
    },
  ])('$name is refused', async ({ field, value, message }) => {
    const res = await createViaForm(userA.client, { title: 'Boundary', [field]: value });
    expect(res.status).toBe(422);
    expectFieldError(res, field, message);
    expect(await countRows(pool, 'tasks')).toBe(0);
  });
});

/**
 * User A's seeded tasks, inserted in this order so that ids do not follow due dates. It repeats
 * due dates, to exercise the id tiebreak, and leaves several tasks undated.
 */
const SEED_TASKS: readonly TaskFixture[] = [
  { status: 'To do', priority: 'High', dueDate: '2026-11-01' },
  { status: 'In progress', priority: 'Low', dueDate: '2026-10-25' },
  { status: 'Done', priority: 'Medium', dueDate: '2026-11-01' },
  { status: 'To do', priority: 'High', dueDate: null },
  { status: 'To do', priority: 'Low', dueDate: '2026-10-25' },
  { status: 'In progress', priority: 'High', dueDate: null },
  { status: 'Done', priority: 'High', dueDate: '2026-09-30' },
  { status: 'To do', priority: 'Medium', dueDate: '2026-11-01' },
  { status: 'In progress', priority: 'Medium', dueDate: '2026-12-31' },
  { status: 'To do', priority: 'High', dueDate: '2026-10-25' },
  { status: 'Done', priority: 'Low', dueDate: null },
];

/** User B's tasks, which must never appear on A's list. */
const FOREIGN_TASKS: readonly TaskFixture[] = [
  { status: 'To do', priority: 'High', dueDate: '2026-10-20' },
  { status: 'Done', priority: 'Low', dueDate: null },
  { status: 'In progress', priority: 'Medium', dueDate: '2026-11-01' },
];

/** A row holding only an id. */
interface IdRow {
  id: number;
}

/** The ids the list must show for the filters, in list order, computed by SQL alone. */
async function expectedListIds(
  ownerId: number,
  status: string | null,
  priority: string | null,
): Promise<number[]> {
  const rows = await sql<IdRow>(
    pool,
    `SELECT id FROM tasks
      WHERE owner_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR priority = $3)
      ORDER BY due_date ASC NULLS LAST, id`,
    [ownerId, status, priority],
  );
  return rows.map((row) => row.id);
}

describe('task list filters, sort and empty states (SC6)', () => {
  test.each<{ query: string; status: string | null; priority: string | null }>([
    { query: '', status: null, priority: null },
    { query: '?status=&priority=', status: null, priority: null },
    { query: '?status=To%20do', status: 'To do', priority: null },
    { query: '?status=In%20progress', status: 'In progress', priority: null },
    { query: '?status=Done', status: 'Done', priority: null },
    { query: '?priority=Low', status: null, priority: 'Low' },
    { query: '?priority=Medium', status: null, priority: 'Medium' },
    { query: '?priority=High', status: null, priority: 'High' },
    { query: '?status=To%20do&priority=High', status: 'To do', priority: 'High' },
  ])('GET /tasks$query lists exactly the matching tasks in due-date order', async (c) => {
    for (const [index, fixture] of SEED_TASKS.entries()) {
      await insertTask(pool, userA.userId, { ...fixture, title: `Seed ${index + 1}` });
    }
    const userB = await newUser();
    for (const [index, fixture] of FOREIGN_TASKS.entries()) {
      await insertTask(pool, userB.userId, { ...fixture, title: `Foreign ${index + 1}` });
    }

    const page = await userA.client.get(`/tasks${c.query}`);
    expect(page.status).toBe(200);
    const expected = await expectedListIds(userA.userId, c.status, c.priority);
    expect(expected.length).toBeGreaterThan(0);
    expect(listIds(page.body)).toEqual(expected);
    expect(page.body).not.toContain('Foreign');
  });

  test('the unfiltered order puts equal due dates in id order and undated tasks last', async () => {
    for (const [index, fixture] of SEED_TASKS.entries()) {
      await insertTask(pool, userA.userId, { ...fixture, title: `Seed ${index + 1}` });
    }
    const page = await userA.client.get('/tasks');
    const byId = new Map((await tasksForOwner(pool, userA.userId)).map((t) => [t.id, t]));
    const rows = listIds(page.body).map((id) => {
      const task = byId.get(id);
      if (task === undefined) {
        throw new Error(`the list shows task ${id}, which A does not own`);
      }
      return task;
    });
    expect(rows.map((t) => t.dueDate)).toEqual([
      '2026-09-30',
      '2026-10-25',
      '2026-10-25',
      '2026-10-25',
      '2026-11-01',
      '2026-11-01',
      '2026-11-01',
      '2026-12-31',
      null,
      null,
      null,
    ]);
    rows.forEach((task, i) => {
      const previous = rows[i - 1];
      if (previous !== undefined && previous.dueDate === task.dueDate) {
        expect(task.id).toBeGreaterThan(previous.id);
      }
    });
  });

  test.each(['', '?status=Done&priority=High'])(
    'a user with no tasks sees the no-tasks state at GET /tasks%s',
    async (query) => {
      const page = await userA.client.get(`/tasks${query}`);
      expect(page.status).toBe(200);
      expect(page.body).toContain('You have no tasks yet.');
      expect(page.body).toMatch(/<a href="\/tasks\/new">Create a task<\/a>/);
      expect(page.body).not.toContain('No tasks match these filters.');
      expect(listIds(page.body)).toEqual([]);
    },
  );

  test('filters that match none of the tasks show the no-matches state', async () => {
    await insertTask(pool, userA.userId, { title: 'Finished', status: 'Done', priority: 'Low' });
    const page = await userA.client.get('/tasks?status=To%20do&priority=High');
    expect(page.status).toBe(200);
    expect(page.body).toContain('No tasks match these filters.');
    expect(page.body).toMatch(/<a href="\/tasks">Clear filters<\/a>/);
    expect(page.body).not.toContain('You have no tasks yet.');
    expect(listIds(page.body)).toEqual([]);
  });
});

describe('status change and delete keep the list filters', () => {
  test.each<{ name: string; echoes: Record<string, string>; location: string }>([
    {
      name: 'with filter echoes',
      echoes: { filterStatus: 'To do', filterPriority: 'High' },
      location: '/tasks?status=To%20do&priority=High',
    },
    {
      name: 'with empty filter echoes',
      echoes: { filterStatus: '', filterPriority: '' },
      location: '/tasks',
    },
  ])('a status change $name redirects to the same list', async ({ echoes, location }) => {
    const task = await insertTask(pool, userA.userId, { status: 'To do', priority: 'High' });
    const res = await postAs(userA, `/tasks/${task.id}/status`, { status: 'Done', ...echoes });
    expect(res.status).toBe(303);
    expect(res.location).toBe(location);
    expect((await storedTask(userA.userId, task.id)).status).toBe('Done');
  });

  test.each<{ name: string; confirm: Record<string, string> }>([
    { name: 'no confirm field', confirm: {} },
    { name: 'an empty confirm field', confirm: { confirm: '' } },
  ])('a delete with $name shows the confirmation step and deletes nothing', async (c) => {
    const task = await insertTask(pool, userA.userId, { title: 'Keep me', status: 'In progress' });
    const res = await postAs(userA, `/tasks/${task.id}/delete`, {
      ...c.confirm,
      filterStatus: 'In progress',
      filterPriority: '',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Delete this task?');
    expect(res.body).toContain('Keep me');
    expect(res.body).toMatch(/<input[^>]*name="confirm"[^>]*value="yes"/);
    expect(res.body).toMatch(/<input[^>]*name="filterStatus"[^>]*value="In progress"/);
    expect(await tasksForOwner(pool, userA.userId)).toEqual([task]);
  });

  test('a confirmed delete removes the task and redirects to the filtered list', async () => {
    const task = await insertTask(pool, userA.userId, { status: 'In progress', priority: 'Low' });
    const res = await postAs(userA, `/tasks/${task.id}/delete`, {
      confirm: 'yes',
      filterStatus: 'In progress',
      filterPriority: 'Low',
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/tasks?status=In%20progress&priority=Low');
    expect(await tasksForOwner(pool, userA.userId)).toEqual([]);
  });
});

/** One request addressed to a task by id, sent as `user`. */
interface TaskRequest {
  name: string;
  send: (user: User, id: number) => Promise<HttpResult>;
}

/** A complete, valid task form. */
const VALID_FORM: Readonly<Record<string, string>> = {
  title: 'Taken over',
  description: '',
  status: 'Done',
  priority: 'Low',
  dueDate: '',
};

/**
 * Every task-id route, including payloads that would be refused (422 or 400) on an owned task:
 * the existence lookup runs first, so they must still give the 404.
 */
const CROSS_USER_REQUESTS: readonly TaskRequest[] = [
  { name: 'GET /tasks/:id/edit', send: (user, id) => user.client.get(`/tasks/${id}/edit`) },
  {
    name: 'POST /tasks/:id/edit with a valid payload',
    send: (user, id) => postAs(user, `/tasks/${id}/edit`, VALID_FORM),
  },
  {
    name: 'POST /tasks/:id/edit with an empty title',
    send: (user, id) => postAs(user, `/tasks/${id}/edit`, { ...VALID_FORM, title: '' }),
  },
  {
    name: 'POST /tasks/:id/status with Done',
    send: (user, id) => postAs(user, `/tasks/${id}/status`, { status: 'Done' }),
  },
  {
    name: 'POST /tasks/:id/status with a malformed status',
    send: (user, id) => postAs(user, `/tasks/${id}/status`, { status: 'Blocked' }),
  },
  {
    name: 'POST /tasks/:id/delete confirmed',
    send: (user, id) => postAs(user, `/tasks/${id}/delete`, { confirm: 'yes' }),
  },
];

describe("another user's task (SC7)", () => {
  test.each(CROSS_USER_REQUESTS)(
    '$name gives the same 404 as a missing task and changes nothing',
    async ({ send }) => {
      const created = await createViaForm(userA.client, {
        title: 'Private plan',
        description: 'Only for A',
        status: 'In progress',
        priority: 'High',
        dueDate: '2026-12-01',
      });
      expect(created.status).toBe(303);
      const original = await onlyTask(userA.userId);
      const userB = await newUser();

      const foreign = await send(userB, original.id);
      const missing = await send(userB, original.id + MISSING_ID_OFFSET);
      expectErrorPage(foreign, 404, TASK_NOT_FOUND);
      expectErrorPage(missing, 404, TASK_NOT_FOUND);
      expect(foreign.body).toBe(missing.body);
      expect(Buffer.compare(foreign.bytes, missing.bytes)).toBe(0);

      expect(await tasksForOwner(pool, userA.userId)).toEqual([original]);
      expect(await tasksForOwner(pool, userB.userId)).toEqual([]);
      const listB = await userB.client.get('/tasks');
      expect(listB.status).toBe(200);
      expect(listB.body).not.toContain('Private plan');
      expect(listB.body).not.toContain(`/tasks/${original.id}/edit`);
    },
  );
});

describe('malformed requests (400, nothing changed)', () => {
  /** Gives A two tasks and returns a snapshot of them. */
  async function seedOwnTasks(): Promise<TaskRow[]> {
    await insertTask(pool, userA.userId, { title: 'First', status: 'To do' });
    await insertTask(pool, userA.userId, { title: 'Second', status: 'Done', priority: 'High' });
    return tasksForOwner(pool, userA.userId);
  }

  test.each([
    '/tasks/abc/edit',
    '/tasks/0/edit',
    '/tasks/1234567890123456/edit',
    '/tasks/%ZZ/edit',
    '/tasks?status=Blocked',
    '/tasks?priority=urgent',
    '/tasks?status=Done&status=To%20do',
  ])('GET %s answers 400', async (path) => {
    const before = await seedOwnTasks();
    expectErrorPage(await userA.client.get(path), 400, BAD_REQUEST);
    expect(await tasksForOwner(pool, userA.userId)).toEqual(before);
  });

  test('a 15-digit id is well-formed, so it answers 404 rather than 400', async () => {
    await seedOwnTasks();
    expectErrorPage(await userA.client.get('/tasks/999999999999999/edit'), 404, TASK_NOT_FOUND);
  });

  test.each<{ name: string; path: (ownId: number) => string; fields: FormFields }>([
    {
      name: 'an unknown status on an owned task',
      path: (ownId) => `/tasks/${ownId}/status`,
      fields: { status: 'Blocked' },
    },
    {
      name: 'a repeated status on an owned task',
      path: (ownId) => `/tasks/${ownId}/status`,
      fields: { status: ['Done', 'To do'] },
    },
    {
      name: 'a non-numeric task id',
      path: () => '/tasks/abc/status',
      fields: { status: 'Done' },
    },
  ])('POST with $name answers 400', async ({ path, fields }) => {
    const before = await seedOwnTasks();
    const own = before[0];
    if (own === undefined) {
      throw new Error('no seeded task');
    }
    expectErrorPage(await postAs(userA, path(own.id), fields), 400, BAD_REQUEST);
    expect(await tasksForOwner(pool, userA.userId)).toEqual(before);
  });
});

describe('unauthenticated requests', () => {
  test.each<{ route: string; path: (id: number) => string }>([
    { route: '/tasks', path: () => '/tasks' },
    { route: '/tasks?status=Done', path: () => '/tasks?status=Done' },
    { route: '/tasks/new', path: () => '/tasks/new' },
    { route: '/tasks/:id/edit', path: (id) => `/tasks/${id}/edit` },
  ])('GET $route redirects 302 to the login page with the return path', async ({ path }) => {
    const task = await insertTask(pool, userA.userId);
    const target = path(task.id);
    const res = await app.client().get(target);
    expect(res.status).toBe(302);
    expect(res.location).toBe(`/login?next=${encodeURIComponent(target)}`);
  });

  test.each<{ route: string; path: (id: number) => string; fields: FormFields }>([
    { route: '/tasks/new', path: () => '/tasks/new', fields: { title: 'Anonymous task' } },
    { route: '/tasks/:id/edit', path: (id) => `/tasks/${id}/edit`, fields: VALID_FORM },
    { route: '/tasks/:id/status', path: (id) => `/tasks/${id}/status`, fields: { status: 'Done' } },
    { route: '/tasks/:id/delete', path: (id) => `/tasks/${id}/delete`, fields: { confirm: 'yes' } },
  ])('POST $route redirects 303 to the login page and writes nothing', async (c) => {
    const task = await insertTask(pool, userA.userId);
    const before = await tasksForOwner(pool, userA.userId);
    const res = await app.client().post(c.path(task.id), { ...c.fields }, { csrf: false });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/login?next=%2Ftasks');
    expect(await tasksForOwner(pool, userA.userId)).toEqual(before);
    expect(await countRows(pool, 'tasks')).toBe(1);
  });
});

/** Every state-changing task route, with a payload that would succeed with a valid token. */
const CSRF_ROUTES: readonly { route: string; path: (id: number) => string; fields: FormFields }[] =
  [
    { route: 'POST /tasks/new', path: () => '/tasks/new', fields: { title: 'Forged task' } },
    { route: 'POST /tasks/:id/edit', path: (id) => `/tasks/${id}/edit`, fields: VALID_FORM },
    {
      route: 'POST /tasks/:id/status',
      path: (id) => `/tasks/${id}/status`,
      fields: { status: 'Done' },
    },
    {
      route: 'POST /tasks/:id/delete',
      path: (id) => `/tasks/${id}/delete`,
      fields: { confirm: 'yes' },
    },
  ];

const CSRF_CASES = CSRF_ROUTES.flatMap((route) =>
  [
    { token: 'no token', csrf: false as const },
    { token: 'a wrong token', csrf: 'wrong' },
  ].map((variant) => ({ ...route, ...variant })),
);

describe('CSRF protection', () => {
  test.each(CSRF_CASES)('$route with $token answers 403 and changes nothing', async (c) => {
    const task = await insertTask(pool, userA.userId, { title: 'Guarded', status: 'To do' });
    const before = await tasksForOwner(pool, userA.userId);
    const res = await userA.client.post(c.path(task.id), { ...c.fields }, { csrf: c.csrf });
    expectErrorPage(res, 403, FORM_EXPIRED);
    expect(await tasksForOwner(pool, userA.userId)).toEqual(before);
    expect(await countRows(pool, 'tasks')).toBe(1);
  });
});

describe('caching of authenticated responses', () => {
  test.each<TaskRequest & { status: number }>([
    { name: 'GET /tasks', status: 200, send: (user) => user.client.get('/tasks') },
    { name: 'GET /tasks/new', status: 200, send: (user) => user.client.get('/tasks/new') },
    {
      name: 'a 303 after POST /tasks/:id/status',
      status: 303,
      send: (user, id) => postAs(user, `/tasks/${id}/status`, { status: 'Done' }),
    },
    {
      name: 'the 404 page for a missing task',
      status: 404,
      send: (user, id) => user.client.get(`/tasks/${id + MISSING_ID_OFFSET}/edit`),
    },
  ])('$name carries Cache-Control: no-store', async ({ send, status }) => {
    const task = await insertTask(pool, userA.userId);
    const res = await send(userA, task.id);
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

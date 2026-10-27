/**
 * Task flows in Chromium: create, edit, one-action status change and delete (SC4); filters and
 * the due-date sort (SC6); both empty list states and inline errors that keep the entered values
 * (SC11); the code-point length limits; the entered-value fallbacks of a re-rendered form; and
 * Control+End reaching the last row of a long list.
 *
 * The shared flows run twice, with JavaScript enabled and disabled, because every task page must
 * work without scripts. Only Delete differs between the two runs: with scripts
 * `confirm-delete.js` asks `window.confirm`, and without them the server answers with its own
 * confirmation page. Each test signs up its own user, so tests share no data and can run in
 * parallel workers.
 */

import {
  expect,
  test,
  type Dialog,
  type Locator,
  type Page,
  type Response,
  type ViewportSize,
} from '@playwright/test';

import { FIXTURE_TIME, createTestPool, sql, userIdByEmail } from '../helpers/test-db';
import { createTask, signUpAndLogIn, taskRow, userTasks } from './support';

/** A task as stored, read through {@link userTasks}. */
type StoredTask = Awaited<ReturnType<typeof userTasks>>[number];

/** The stored fields that address a listed task: its id for the routes, its title for the row. */
type TaskRef = Pick<StoredTask, 'id' | 'title'>;

/** Fields {@link createTask} enters on the new-task form. */
type NewTask = Parameters<typeof createTask>[1];

/** Deletes a listed task from the task list, confirming the deletion as the run allows. */
type DeleteFromList = (page: Page, task: TaskRef) => Promise<void>;

/** The Status, Priority and Due date cells of one task-list row, as displayed. */
interface RowCells {
  status: string;
  priority: string;
  dueDate: string;
}

/** List filters chosen in the filter form; an omitted field selects "All". */
interface ListFilters {
  status?: string;
  priority?: string;
}

/** What a dialog showed: its type, such as `confirm`, and its message. */
interface SeenDialog {
  type: string;
  message: string;
}

/** The page's scroll offset and where the last task-list row sits, all in CSS pixels. */
interface ListScrollState {
  /** Whether the scroll offset held still over two animation frames, so no scroll is moving. */
  settled: boolean;
  /** The vertical scroll offset. */
  scrollY: number;
  /** The last row's top edge, from the top of the viewport. */
  lastRowTop: number;
  /** The last row's bottom edge, from the top of the viewport. */
  lastRowBottom: number;
  /** The viewport's height. */
  viewportHeight: number;
}

/** Where the long list is shown for Control+End, each press checked on its own. */
interface EndKeyCase {
  name: string;
  /** The viewport the list loads in, where Control+End is pressed first. */
  load: ViewportSize;
  /**
   * When given, the list then goes back to its top, is resized to this viewport and gets a second
   * press, so the groups at its end were last laid out at another width.
   */
  resizeTo?: ViewportSize;
}

/** The due-date `<input>` start tag of the task form, whatever the order of its attributes. */
const DUE_DATE_INPUT = /<input\b[^>]*\bname="dueDate"[^>]*>/;

/** The task form's priority `<select>` up to its options' end, then its closing tag. */
const PRIORITY_SELECT = /(<select\b[^>]*\bname="priority"[^>]*>[\s\S]*?)(<\/select>)/;

/** The task form's status `<select>` up to its options' end, then its closing tag. */
const STATUS_SELECT = /(<select\b[^>]*\bname="status"[^>]*>[\s\S]*?)(<\/select>)/;

/**
 * Titles holding a line break, each with the value its edit-form textarea shows: the HTML parser
 * turns every CR and CRLF into LF. The last title has exactly 200 code points, the longest
 * accepted, so the browser's CRLF makes the submitted title 201.
 */
const LINE_BREAK_TITLES: readonly { name: string; title: string; shown: string }[] = [
  { name: 'a CRLF line break', title: 'Plan\r\nreview', shown: 'Plan\nreview' },
  { name: 'an LF line break', title: 'Plan\nreview', shown: 'Plan\nreview' },
  { name: 'a CR line break', title: 'Plan\rreview', shown: 'Plan\nreview' },
  {
    name: 'an LF line break at 200 code points',
    title: `${'a'.repeat(100)}\n${'b'.repeat(99)}`,
    shown: `${'a'.repeat(100)}\n${'b'.repeat(99)}`,
  },
];

/**
 * Tasks in the long list: five of the task table's 50-row groups. The first screen renders the
 * first and the last two always render, so Control+End passes two groups that render only during
 * the scroll before it lands in the last.
 */
const LONG_LIST_TASKS = 250;

/**
 * How long a key-driven scroll may take to come to rest on a busy host. A press scrolls smoothly
 * over several frames, so the checks retry until the page is still.
 */
const SCROLL_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Viewports for Control+End: a phone, just above the small-screen breakpoint (40rem, 640px), a
 * small laptop, and a desktop, whose list is then resized to a phone after its end was laid out
 * at desktop width.
 */
const END_KEY_CASES: readonly EndKeyCase[] = [
  { name: 'a list loaded at 375x812', load: { width: 375, height: 812 } },
  { name: 'a list loaded at 641x812', load: { width: 641, height: 812 } },
  { name: 'a list loaded at 1024x768', load: { width: 1024, height: 768 } },
  {
    name: 'a list loaded at 1280x800, then resized to 375x812',
    load: { width: 1280, height: 800 },
    resizeTo: { width: 375, height: 812 },
  },
];

/**
 * Clicks `control` and returns the response to the `POST` it submits to `path`. The wait is
 * registered before the click, so a fast response cannot be missed. After a redirect the
 * response is the `303` itself, which the browser then follows.
 */
async function clickAndAwaitPost(page: Page, control: Locator, path: string): Promise<Response> {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
  );
  await control.click();
  return response;
}

/**
 * Clicks `control` and answers the dialog the click opens, returning what the dialog showed.
 * The click stays pending while a dialog is open, so the dialog is answered from the event
 * handler. The current document must have run its deferred scripts first, so the click waits for
 * its `load`. A click that opens no dialog fails.
 */
async function clickAnsweringDialog(
  page: Page,
  control: Locator,
  answer: 'accept' | 'dismiss',
): Promise<SeenDialog> {
  const seen: SeenDialog[] = [];
  const answered: Promise<void>[] = [];
  const onDialog = (dialog: Dialog): void => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    answered.push(answer === 'accept' ? dialog.accept() : dialog.dismiss());
  };
  await page.waitForLoadState('load');
  page.once('dialog', onDialog);
  await control.click();
  await Promise.all(answered);
  const [dialog] = seen;
  if (dialog === undefined) {
    page.off('dialog', onDialog);
    throw new Error('the click opened no dialog');
  }
  return dialog;
}

/** The stored task titled `title` of the user with `email`; fails when there is none. */
async function storedTask(email: string, title: string): Promise<StoredTask> {
  const task = (await userTasks(email)).find((t) => t.title === title);
  if (task === undefined) {
    throw new Error(`no stored task is titled "${title}"`);
  }
  return task;
}

/** The titles of the user's stored tasks, in creation order. */
async function storedTitles(email: string): Promise<string[]> {
  return (await userTasks(email)).map((t) => t.title);
}

/**
 * Inserts `count` undated tasks for the user with `email` in one statement, straight into the
 * test database. Task `n` is titled `n` as five digits, then a space and repeated "lorem ipsum
 * dolor sit amet" words cut at 200 code points, the longest title the form accepts, so every row
 * wraps to several lines. The list orders undated tasks by id, so task `count` is the last row.
 */
async function insertLongTitledTasks(email: string, count: number): Promise<void> {
  const pool = createTestPool();
  try {
    const ownerId = await userIdByEmail(pool, email);
    if (ownerId === null) {
      throw new Error(`insertLongTitledTasks: no user has the email ${email}`);
    }
    await sql(
      pool,
      'INSERT INTO tasks (owner_id, title, created_at, updated_at) ' +
        "SELECT $1, left(lpad(g.i::text, 5, '0') || repeat($4, 8), 200), $2, $2 " +
        'FROM generate_series(1, $3::int) AS g(i)',
      [ownerId, FIXTURE_TIME, count, ' lorem ipsum dolor sit amet'],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Reads the page's {@link ListScrollState}. The read waits two animation frames, so the layout
 * of a resize or a scroll step has run, and reports `settled` only when the scroll offset did not
 * move meanwhile.
 */
async function listScrollState(page: Page): Promise<ListScrollState> {
  return page.evaluate(async () => {
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const before = window.scrollY;
    await nextFrame();
    await nextFrame();
    const rows = document.querySelectorAll('table tbody tr');
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new Error('the task table has no rows');
    }
    const box = last.getBoundingClientRect();
    return {
      settled: window.scrollY === before,
      scrollY: window.scrollY,
      lastRowTop: box.top,
      lastRowBottom: box.bottom,
      viewportHeight: window.innerHeight,
    };
  });
}

/**
 * Presses `key` once and waits for the smooth scroll it starts to fire `scrollend`. The scroll can
 * look still for a few frames before it ends, and a key pressed then is dropped, so the next
 * press waits for the event. The listener is in place before the press, so the event cannot be
 * missed; a press that starts no scroll fails after {@link SCROLL_SETTLE_TIMEOUT_MS}.
 */
async function pressScrollKey(page: Page, key: string): Promise<void> {
  const watcher = await page.evaluateHandle(
    ({ timeoutMs, pressed }) => ({
      ended: new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${pressed} started no scroll that ended within ${timeoutMs} ms`));
        }, timeoutMs);
        addEventListener(
          'scrollend',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    }),
    { timeoutMs: SCROLL_SETTLE_TIMEOUT_MS, pressed: key },
  );
  try {
    await page.keyboard.press(key);
    await watcher.evaluate((w) => w.ended);
  } finally {
    await watcher.dispose();
  }
}

/**
 * Presses Control+End once and waits for the scroll to come to rest with the last task-list row
 * wholly inside the viewport.
 */
async function expectOneEndPressToShowLastRow(page: Page): Promise<void> {
  await pressScrollKey(page, 'Control+End');
  await expectScrollToSettle(page, (s) => {
    expect(s.lastRowTop, 'the last row starts above the viewport').toBeGreaterThanOrEqual(0);
    expect(s.lastRowBottom, 'the last row ends below the viewport').toBeLessThanOrEqual(
      s.viewportHeight,
    );
  });
}

/**
 * Waits until the page has stopped scrolling and `check` passes on its {@link ListScrollState},
 * retrying both until {@link SCROLL_SETTLE_TIMEOUT_MS}. It presses nothing, so a scroll that
 * comes to rest in the wrong place fails rather than being given a second press.
 */
async function expectScrollToSettle(
  page: Page,
  check: (state: ListScrollState) => void,
): Promise<void> {
  await expect(async () => {
    const state = await listScrollState(page);
    expect(state.settled, 'the page is still scrolling').toBe(true);
    check(state);
  }).toPass({ timeout: SCROLL_SETTLE_TIMEOUT_MS });
}

/** Asserts the task titled `title` is listed exactly once, showing these cells. */
async function expectListedTask(page: Page, title: string, cells: RowCells): Promise<void> {
  const row = taskRow(page, title);
  await expect(row).toHaveCount(1);
  // Columns: Title, Status, Priority, Due date, Actions.
  const cell = row.getByRole('cell');
  await expect(cell.nth(1)).toHaveText(cells.status);
  await expect(cell.nth(2)).toHaveText(cells.priority);
  await expect(cell.nth(3)).toHaveText(cells.dueDate);
}

/** The title cells of the listed rows, top to bottom. */
function titleColumn(page: Page): Locator {
  return page.locator('table tbody tr > td:first-child');
}

/** The Delete button of the listed task titled `title`. */
function deleteButton(page: Page, title: string): Locator {
  return taskRow(page, title).getByRole('button', { name: 'Delete', exact: true });
}

/** The list's filter form; the page also shows "Status" and "Priority" in the table. */
function filterForm(page: Page): Locator {
  return page.locator('form').filter({
    has: page.getByRole('button', { name: 'Apply filters', exact: true }),
  });
}

/**
 * Chooses the filters in the filter form, clicks "Apply filters" and waits for the filtered list.
 * The query is compared decoded, because the browser encodes a space in it as `+`.
 */
async function applyFilters(page: Page, filters: ListFilters): Promise<void> {
  const form = filterForm(page);
  const status = filters.status ?? '';
  const priority = filters.priority ?? '';
  // The "All" option's value is empty.
  await form.getByLabel('Status', { exact: true }).selectOption({ value: status });
  await form.getByLabel('Priority', { exact: true }).selectOption({ value: priority });
  await form.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(
    (u) =>
      u.pathname === '/tasks' &&
      u.searchParams.get('status') === status &&
      u.searchParams.get('priority') === priority,
  );
}

/** Asserts the page is the unfiltered task list. */
async function expectUnfilteredList(page: Page): Promise<void> {
  await expect(page).toHaveURL((u) => u.pathname === '/tasks' && u.search === '');
}

/** Matches any text that contains `text` literally. */
function containing(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Asserts `message` is shown as `field`'s inline error: visible in the field's own alert, the
 * element `<field id>-error` (the form's error summary repeats the text as a link), part of the
 * field's accessible description (the form links it through `aria-describedby`), and the field
 * marked invalid.
 */
async function expectInlineError(field: Locator, message: string): Promise<void> {
  const id = await field.getAttribute('id');
  if (id === null) {
    throw new Error('expectInlineError: the field has no id to find its inline error by');
  }
  const inline = field.page().locator(`[id="${id}-error"]`);
  await expect(inline).toBeVisible();
  await expect(inline).toHaveText(message);
  await expect(inline).toHaveRole('alert');
  await expect(field).toHaveAccessibleDescription(containing(message));
  await expect(field).toHaveAttribute('aria-invalid', 'true');
}

/**
 * Clicks the listed task's Delete button without JavaScript and checks the server's
 * confirmation step: a 200 page naming the task, with nothing deleted yet.
 */
async function openConfirmationPage(page: Page, task: TaskRef): Promise<void> {
  const step = await clickAndAwaitPost(
    page,
    deleteButton(page, task.title),
    `/tasks/${task.id}/delete`,
  );
  expect(step.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Delete this task?', exact: true })).toBeVisible();
  await expect(page.locator('main').getByText(task.title, { exact: true })).toBeVisible();
}

/** With JavaScript: Delete asks `window.confirm` with the task's title, and OK deletes it. */
async function deleteThroughDialog(page: Page, task: TaskRef): Promise<void> {
  const dialog = await clickAnsweringDialog(page, deleteButton(page, task.title), 'accept');
  expect(dialog).toEqual({ type: 'confirm', message: `Delete "${task.title}"?` });
}

/** Without JavaScript: Delete opens the confirmation page, and "Delete task" deletes the task. */
async function deleteThroughConfirmationPage(page: Page, task: TaskRef): Promise<void> {
  await openConfirmationPage(page, task);
  const deleted = await clickAndAwaitPost(
    page,
    page.getByRole('button', { name: 'Delete task', exact: true }),
    `/tasks/${task.id}/delete`,
  );
  expect(deleted.status()).toBe(303);
}

/**
 * Defines the flows that must behave the same with and without JavaScript, deleting through
 * `deleteFromList`, the confirmation the run's describe block supports.
 */
function defineSharedFlows(deleteFromList: DeleteFromList): void {
  test('creates, edits, changes the status of and deletes a task, each shown at once', async ({
    page,
  }) => {
    const { email } = await signUpAndLogIn(page);
    const first = 'Draft the quarterly plan';
    const renamed = 'Publish the quarterly plan';

    await createTask(page, { title: first, priority: 'Low', dueDate: '2030-01-15' });
    await expectListedTask(page, first, {
      status: 'To do',
      priority: 'Low',
      dueDate: '2030-01-15',
    });
    const { id } = await storedTask(email, first);

    await taskRow(page, first).getByRole('link', { name: first, exact: true }).click();
    await expect(page).toHaveURL((u) => u.pathname === `/tasks/${id}/edit`);
    const form = page.locator(`form[action="/tasks/${id}/edit"]`);
    const title = form.getByLabel('Title', { exact: true });
    const priority = form.getByLabel('Priority', { exact: true });
    const dueDate = form.getByLabel('Due date', { exact: true });
    await expect(title).toHaveValue(first);
    await expect(form.getByLabel('Description', { exact: true })).toHaveValue('');
    await expect(form.getByLabel('Status', { exact: true })).toHaveValue('To do');
    await expect(priority).toHaveValue('Low');
    await expect(dueDate).toHaveValue('2030-01-15');
    await title.fill(renamed);
    await priority.selectOption('High');
    await dueDate.fill('2030-02-01');
    const saved = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      `/tasks/${id}/edit`,
    );
    expect(saved.status()).toBe(303);
    await expectUnfilteredList(page);
    await expectListedTask(page, renamed, {
      status: 'To do',
      priority: 'High',
      dueDate: '2030-02-01',
    });
    await expect(taskRow(page, first)).toHaveCount(0);

    // Each row offers one button per status the task is not in.
    const row = taskRow(page, renamed);
    const marks = row.getByRole('button', { name: /^Mark / });
    await expect(marks).toHaveText(['Mark In progress', 'Mark Done']);
    const steps = [
      { button: 'Mark In progress', status: 'In progress', others: ['Mark To do', 'Mark Done'] },
      { button: 'Mark Done', status: 'Done', others: ['Mark To do', 'Mark In progress'] },
      { button: 'Mark To do', status: 'To do', others: ['Mark In progress', 'Mark Done'] },
    ];
    for (const step of steps) {
      const changed = await clickAndAwaitPost(
        page,
        row.getByRole('button', { name: step.button, exact: true }),
        `/tasks/${id}/status`,
      );
      expect(changed.status()).toBe(303);
      await expectUnfilteredList(page);
      await expectListedTask(page, renamed, {
        status: step.status,
        priority: 'High',
        dueDate: '2030-02-01',
      });
      await expect(marks).toHaveText(step.others);
      // Entering Done records the completion time and leaving it clears the time.
      const { completedAt } = await storedTask(email, renamed);
      if (step.status === 'Done') {
        expect(completedAt).toBeInstanceOf(Date);
      } else {
        expect(completedAt).toBeNull();
      }
    }

    await deleteFromList(page, { id, title: renamed });
    await expectUnfilteredList(page);
    await expect(taskRow(page, renamed)).toHaveCount(0);
    await expect(page.getByText('You have no tasks yet.', { exact: true })).toBeVisible();
    expect(await userTasks(email)).toEqual([]);
  });

  test('filters by status and priority, sorted by due date with undated tasks last', async ({
    page,
  }) => {
    const { email } = await signUpAndLogIn(page);
    // Created out of order: the list sorts by due date, undated last, then by id.
    const tasks: readonly NewTask[] = [
      { title: 'T1', status: 'To do', priority: 'High', dueDate: '2030-03-10' },
      { title: 'T2', status: 'To do', priority: 'High' },
      { title: 'T3', status: 'To do', priority: 'High', dueDate: '2030-03-01' },
      { title: 'T4', status: 'In progress', priority: 'High', dueDate: '2030-01-01' },
      { title: 'T5', status: 'To do', priority: 'Low', dueDate: '2030-01-01' },
      { title: 'T6', status: 'Done', priority: 'Medium', dueDate: '2029-12-01' },
    ];
    for (const task of tasks) {
      await createTask(page, task);
    }
    const fullOrder = ['T6', 'T4', 'T5', 'T3', 'T1', 'T2'];
    await expect(titleColumn(page)).toHaveText(fullOrder);
    await expect(taskRow(page, 'T2').getByRole('cell').nth(3)).toHaveText('\u2014');

    await applyFilters(page, { status: 'To do', priority: 'High' });
    await expect(titleColumn(page)).toHaveText(['T3', 'T1', 'T2']);
    await expect(filterForm(page).getByLabel('Status', { exact: true })).toHaveValue('To do');
    await expect(filterForm(page).getByLabel('Priority', { exact: true })).toHaveValue('High');

    await applyFilters(page, { status: 'In progress' });
    await expect(titleColumn(page)).toHaveText(['T4']);

    await applyFilters(page, { priority: 'Low' });
    await expect(titleColumn(page)).toHaveText(['T5']);

    await filterForm(page).getByRole('link', { name: 'Clear filters', exact: true }).click();
    await expectUnfilteredList(page);
    await expect(titleColumn(page)).toHaveText(fullOrder);

    // A status change answers with the list it was made from, filters included.
    await page.goto('/tasks?status=To%20do&priority=High');
    await expect(titleColumn(page)).toHaveText(['T3', 'T1', 'T2']);
    const t3 = await storedTask(email, 'T3');
    const changed = await clickAndAwaitPost(
      page,
      taskRow(page, 'T3').getByRole('button', { name: 'Mark Done', exact: true }),
      `/tasks/${t3.id}/status`,
    );
    expect(changed.status()).toBe(303);
    await expect(titleColumn(page)).toHaveText(['T1', 'T2']);
    await expect(page).toHaveURL(
      (u) =>
        u.pathname === '/tasks' &&
        u.searchParams.get('status') === 'To do' &&
        u.searchParams.get('priority') === 'High',
    );
    expect((await storedTask(email, 'T3')).status).toBe('Done');
  });

  test('shows both empty states, each with its link', async ({ page }) => {
    await signUpAndLogIn(page);
    await expect(page.getByText('You have no tasks yet.', { exact: true })).toBeVisible();
    const createLink = page.getByRole('link', { name: 'Create a task', exact: true });
    await expect(createLink).toHaveAttribute('href', '/tasks/new');
    await createLink.click();
    await expect(page).toHaveURL((u) => u.pathname === '/tasks/new');
    await expect(page.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();

    const errand = 'Water the plants';
    await createTask(page, { title: errand, priority: 'Low' });
    await applyFilters(page, { priority: 'High' });
    await expect(page.getByText('No tasks match these filters.', { exact: true })).toBeVisible();
    await expect(page.getByText('You have no tasks yet.', { exact: true })).toHaveCount(0);
    await expect(titleColumn(page)).toHaveCount(0);
    // The filter form's link and the empty state's, rendered after it.
    const clearLinks = page.getByRole('link', { name: 'Clear filters', exact: true });
    await expect(clearLinks).toHaveCount(2);
    for (const link of await clearLinks.all()) {
      await expect(link).toHaveAttribute('href', '/tasks');
    }
    await clearLinks.last().click();
    await expectUnfilteredList(page);
    await expect(taskRow(page, errand)).toHaveCount(1);
  });

  test('keeps every entered value beside an inline error and saves nothing', async ({ page }) => {
    const { email } = await signUpAndLogIn(page);
    await page.goto('/tasks/new');
    const form = page.locator('form[action="/tasks/new"]');
    const title = form.getByLabel('Title', { exact: true });
    const description = form.getByLabel('Description', { exact: true });
    const status = form.getByLabel('Status', { exact: true });
    const priority = form.getByLabel('Priority', { exact: true });
    const dueDate = form.getByLabel('Due date', { exact: true });
    // `required` makes the browser itself refuse an empty title, with or without scripts, so a
    // title of spaces is how a submission reaches the server's trim rule.
    await title.fill('   ');
    await description.fill('first line\nsecond line');
    await status.selectOption('In progress');
    await priority.selectOption('High');
    await dueDate.fill('2030-05-05');
    const refused = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      '/tasks/new',
    );
    expect(refused.status()).toBe(422);

    await expectInlineError(title, 'Title is required.');
    // The error summary links the message to its field, which the page focused on load.
    const summary = form.getByRole('region', { name: 'The task was not saved', exact: true });
    await expect(summary.getByRole('link')).toHaveText(['Title is required.']);
    await expect(summary.getByRole('link')).toHaveAttribute('href', '#title');
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('   ');
    // The browser submits the line break as CRLF, and parsing the re-rendered textarea turns it
    // back into the LF of the DOM value.
    await expect(description).toHaveValue('first line\nsecond line');
    await expect(status).toHaveValue('In progress');
    await expect(priority).toHaveValue('High');
    await expect(dueDate).toHaveValue('2030-05-05');
    expect(await userTasks(email)).toEqual([]);
  });

  for (const c of LINE_BREAK_TITLES) {
    test(`keeps a title holding ${c.name} through a priority-only edit`, async ({ page }) => {
      const { email } = await signUpAndLogIn(page);
      // The new-task form's single-line input cannot take a line break, so the task is created by
      // a request posting the form's own CSRF token with the page's cookies. Its form encoding
      // sends each line break unchanged, so the stored title is exactly the original.
      await page.goto('/tasks/new');
      const csrf = await page
        .locator('form[action="/tasks/new"] input[name="_csrf"]')
        .inputValue();
      const created = await page.request.post('/tasks/new', {
        form: { _csrf: csrf, title: c.title },
        maxRedirects: 0,
      });
      expect(created.status()).toBe(303);
      const { id } = await storedTask(email, c.title);

      await page.goto(`/tasks/${id}/edit`);
      const form = page.locator(`form[action="/tasks/${id}/edit"]`);
      const titleField = form.getByLabel('Title', { exact: true });
      // The title is edited in a textarea, whose DOM value holds each line break as LF; a text
      // input would have stripped it.
      await expect(form.locator('textarea[name="title"]')).toHaveCount(1);
      await expect(form.locator('input[name="title"]')).toHaveCount(0);
      await expect(titleField).toHaveValue(c.shown);
      await form.getByLabel('Priority', { exact: true }).selectOption('High');
      const saved = await clickAndAwaitPost(
        page,
        form.getByRole('button', { name: 'Save', exact: true }),
        `/tasks/${id}/edit`,
      );
      // The browser submits every line break as CRLF, whatever the stored title holds.
      const submitted = new URLSearchParams(saved.request().postData() ?? '').get('title');
      expect(submitted).toBe(c.shown.replaceAll('\n', '\r\n'));
      expect(saved.status()).toBe(303);
      await expectUnfilteredList(page);
      // The server recognises the unchanged title, so the stored one keeps its line breaks.
      expect(await userTasks(email)).toEqual([
        expect.objectContaining({ id, title: c.title, priority: 'High' }),
      ]);
    });
  }

  test('limits the title and description in code points, not UTF-16 units', async ({ page }) => {
    // Filling the 5,000-character description is the slow step on a busy host.
    test.setTimeout(60_000);
    const { email } = await signUpAndLogIn(page);
    // U+1D49C lies outside the Basic Multilingual Plane: one code point, two UTF-16 units.
    const title200 = '\u{1D49C}'.repeat(100) + 'a'.repeat(100);
    expect([...title200]).toHaveLength(200);
    expect(title200).toHaveLength(300);
    await createTask(page, { title: title200 });
    await expect(taskRow(page, title200)).toHaveCount(1);
    expect(await storedTitles(email)).toEqual([title200]);

    const title201 = `${title200}b`;
    await page.goto('/tasks/new');
    const form = page.locator('form[action="/tasks/new"]');
    const title = form.getByLabel('Title', { exact: true });
    await title.fill(title201);
    // No `maxlength` may cut the value in the browser: the server sees all 201 code points.
    await expect(title).toHaveValue(title201);
    const refused = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      '/tasks/new',
    );
    expect(refused.status()).toBe(422);
    await expectInlineError(title, 'Title must be at most 200 characters.');
    await expect(title).toHaveValue(title201);
    expect(await storedTitles(email)).toEqual([title200]);

    const description5000 = '\u{1F600}'.repeat(1000) + 'x'.repeat(4000);
    expect([...description5000]).toHaveLength(5000);
    const emojiTitle = 'Emoji description';
    await createTask(page, { title: emojiTitle, description: description5000 });
    await expect(taskRow(page, emojiTitle)).toHaveCount(1);
    const stored = await storedTask(email, emojiTitle);
    expect(stored.description).toBe(description5000);
    expect([...stored.description]).toHaveLength(5000);
  });

  test('refuses a 5,001-code-point description and keeps it in the form', async ({ page }) => {
    // Filling the 5,001-character description is the slow step on a busy host.
    test.setTimeout(60_000);
    const { email } = await signUpAndLogIn(page);
    // U+1F600 lies outside the Basic Multilingual Plane: one code point, two UTF-16 units. It has
    // no line break, which the browser would submit as CRLF and so lengthen by a code point.
    const description5001 = '\u{1F600}'.repeat(1000) + 'x'.repeat(4001);
    expect([...description5001]).toHaveLength(5001);
    expect(description5001).toHaveLength(6001);
    const titleText = 'Overlong description';
    await page.goto('/tasks/new');
    const form = page.locator('form[action="/tasks/new"]');
    const title = form.getByLabel('Title', { exact: true });
    const description = form.getByLabel('Description', { exact: true });
    await title.fill(titleText);
    await description.fill(description5001);
    // No `maxlength` may cut the value in the browser: the server sees all 5,001 code points.
    await expect(description).toHaveValue(description5001);
    const refused = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      '/tasks/new',
    );
    expect(refused.status()).toBe(422);

    await expectInlineError(description, 'Description must be at most 5,000 characters.');
    // The description is the only invalid field, so it alone is listed and it takes the focus.
    const summary = form.getByRole('region', { name: 'The task was not saved', exact: true });
    await expect(summary.getByRole('link')).toHaveText([
      'Description must be at most 5,000 characters.',
    ]);
    await expect(summary.getByRole('link')).toHaveAttribute('href', '#description');
    await expect(description).toBeFocused();
    await expect(description).toHaveValue(description5001);
    await expect(title).toHaveValue(titleText);
    expect(await userTasks(email)).toEqual([]);
  });
}

test.describe('tasks with JavaScript', () => {
  defineSharedFlows(deleteThroughDialog);

  test('Delete asks for confirmation: OK deletes the task, Cancel keeps it', async ({ page }) => {
    const { email } = await signUpAndLogIn(page);
    const removed = 'Cancel the gym membership';
    const kept = 'Renew the passport';
    await createTask(page, { title: removed });
    await createTask(page, { title: kept });

    const accepted = await clickAnsweringDialog(page, deleteButton(page, removed), 'accept');
    expect(accepted).toEqual({ type: 'confirm', message: `Delete "${removed}"?` });
    await expectUnfilteredList(page);
    await expect(taskRow(page, removed)).toHaveCount(0);
    await expect(taskRow(page, kept)).toHaveCount(1);

    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') {
        posts.push(request.url());
      }
    });
    const dismissed = await clickAnsweringDialog(page, deleteButton(page, kept), 'dismiss');
    expect(dismissed).toEqual({ type: 'confirm', message: `Delete "${kept}"?` });
    await page.waitForLoadState('load');
    // Cancel stops the submission itself: no request leaves the page and it stays on the list.
    expect(posts).toEqual([]);
    await expectUnfilteredList(page);
    await expect(taskRow(page, kept)).toHaveCount(1);
    expect(await storedTitles(email)).toEqual([kept]);
  });

  // Control+End is the browser's own scrolling and needs no script, so this one run covers both.
  test('one Control+End press brings the last of 250 long-titled tasks fully into view', async ({
    page,
  }) => {
    // Four page loads and six smooth scrolls follow the two bcrypt-bound form posts.
    test.setTimeout(60_000);
    const { email } = await signUpAndLogIn(page);
    await insertLongTitledTasks(email, LONG_LIST_TASKS);
    for (const c of END_KEY_CASES) {
      await test.step(c.name, async () => {
        await page.setViewportSize(c.load);
        await page.goto('/tasks');
        await expect(page.locator('table tbody tr')).toHaveCount(LONG_LIST_TASKS);
        await expectOneEndPressToShowLastRow(page);
        const { resizeTo } = c;
        if (resizeTo !== undefined) {
          await pressScrollKey(page, 'Control+Home');
          await expectScrollToSettle(page, (s) => expect(s.scrollY).toBe(0));
          await page.setViewportSize(resizeTo);
          await expectScrollToSettle(page, (s) => {
            expect(s.viewportHeight).toBe(resizeTo.height);
            expect(s.scrollY).toBe(0);
          });
          await expectOneEndPressToShowLastRow(page);
        }
      });
    }
  });
});

test.describe('tasks without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  defineSharedFlows(deleteThroughConfirmationPage);

  test('Delete asks on a confirmation page: Delete task deletes, Cancel keeps', async ({
    page,
  }) => {
    const { email } = await signUpAndLogIn(page);
    await createTask(page, { title: 'Return the library books' });
    await createTask(page, { title: 'Book the dentist' });

    const confirmed = await storedTask(email, 'Return the library books');
    await openConfirmationPage(page, confirmed);
    expect(await storedTitles(email)).toEqual(['Return the library books', 'Book the dentist']);
    const deleted = await clickAndAwaitPost(
      page,
      page.getByRole('button', { name: 'Delete task', exact: true }),
      `/tasks/${confirmed.id}/delete`,
    );
    expect(deleted.status()).toBe(303);
    await expectUnfilteredList(page);
    await expect(taskRow(page, 'Return the library books')).toHaveCount(0);
    await expect(taskRow(page, 'Book the dentist')).toHaveCount(1);

    const cancelled = await storedTask(email, 'Book the dentist');
    await openConfirmationPage(page, cancelled);
    await page.getByRole('link', { name: 'Cancel', exact: true }).click();
    await expectUnfilteredList(page);
    await expect(taskRow(page, 'Book the dentist')).toHaveCount(1);
    expect(await storedTitles(email)).toEqual(['Book the dentist']);
  });

  test('Delete from a filtered list returns to the same filters', async ({ page }) => {
    const { email } = await signUpAndLogIn(page);
    await createTask(page, { title: 'Fix the roof', priority: 'High' });
    await createTask(page, { title: 'Sort the photos', priority: 'Low' });
    await applyFilters(page, { priority: 'High' });
    await expect(titleColumn(page)).toHaveText(['Fix the roof']);

    const task = await storedTask(email, 'Fix the roof');
    await openConfirmationPage(page, task);
    await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute(
      'href',
      '/tasks?priority=High',
    );
    const deleted = await clickAndAwaitPost(
      page,
      page.getByRole('button', { name: 'Delete task', exact: true }),
      `/tasks/${task.id}/delete`,
    );
    expect(deleted.status()).toBe(303);
    await expect(page).toHaveURL(
      (u) =>
        u.pathname === '/tasks' &&
        u.searchParams.get('priority') === 'High' &&
        !u.searchParams.has('status'),
    );
    await expect(page.getByText('No tasks match these filters.', { exact: true })).toBeVisible();
    expect(await storedTitles(email)).toEqual(['Sort the photos']);
  });

  test('keeps an invalid date and an unknown priority visible after a failed submission', async ({
    page,
  }) => {
    const { email } = await signUpAndLogIn(page);
    // The real form offers only valid choices: a date picker and the three priorities. Its page is
    // rewritten on the way to the browser to offer a text date field and an extra "Urgent"
    // priority, as a stale or tampered form would; only GET is rewritten, so the submission and
    // the 422 page that answers it are the server's own.
    await page.route('**/tasks/new', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      const withTextDate = body.replace(DUE_DATE_INPUT, (tag) =>
        tag.replace('type="date"', 'type="text"'),
      );
      const rewritten = withTextDate.replace(
        PRIORITY_SELECT,
        '$1<option value="Urgent">Urgent</option>$2',
      );
      // A markup change must fail the test rather than leave the page unrewritten.
      if (withTextDate === body || rewritten === withTextDate) {
        throw new Error('the new-task page lacks the due-date input or priority select to rewrite');
      }
      // The fetched Content-Length no longer fits the body; without it the new length is sent.
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(([name]) => name !== 'content-length'),
      );
      await route.fulfill({ response, body: rewritten, headers });
    });

    await page.goto('/tasks/new');
    const form = page.locator('form[action="/tasks/new"]');
    const title = form.getByLabel('Title', { exact: true });
    const priority = form.getByLabel('Priority', { exact: true });
    const dueDate = form.getByLabel('Due date', { exact: true });
    await expect(dueDate).toHaveAttribute('type', 'text');
    await expect(priority.locator('option')).toHaveText(['Low', 'Medium', 'High', 'Urgent']);
    await title.fill('Fallback task');
    await dueDate.fill('2026-02-30');
    await priority.selectOption('Urgent');
    const refused = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      '/tasks/new',
    );
    expect(refused.status()).toBe(422);

    // A browser would empty an invalid value in a date control, so the server renders a text one.
    await expect(dueDate).toHaveAttribute('type', 'text');
    await expect(dueDate).toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await expect(dueDate).toHaveValue('2026-02-30');
    await expectInlineError(dueDate, 'Enter a valid date (YYYY-MM-DD).');
    await expect(priority).toHaveValue('Urgent');
    await expect(priority.locator('option:checked')).toHaveText('Urgent (invalid)');
    await expect(priority.locator('option')).toHaveText([
      'Low',
      'Medium',
      'High',
      'Urgent (invalid)',
    ]);
    await expectInlineError(priority, 'Choose a valid priority.');
    await expect(title).toHaveValue('Fallback task');
    expect(await userTasks(email)).toEqual([]);
  });

  test('keeps an unknown status visible after a failed submission', async ({ page }) => {
    const { email } = await signUpAndLogIn(page);
    // The real form offers only the three statuses. Its page is rewritten on the way to the
    // browser to offer an extra "Blocked" status, as a stale or tampered form would; only GET is
    // rewritten, so the submission and the 422 page that answers it are the server's own.
    await page.route('**/tasks/new', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      const rewritten = body.replace(STATUS_SELECT, '$1<option value="Blocked">Blocked</option>$2');
      // A markup change must fail the test rather than leave the page unrewritten.
      if (rewritten === body) {
        throw new Error('the new-task page lacks the status select to rewrite');
      }
      // The fetched Content-Length no longer fits the body; without it the new length is sent.
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(([name]) => name !== 'content-length'),
      );
      await route.fulfill({ response, body: rewritten, headers });
    });

    await page.goto('/tasks/new');
    const form = page.locator('form[action="/tasks/new"]');
    const title = form.getByLabel('Title', { exact: true });
    const status = form.getByLabel('Status', { exact: true });
    const priority = form.getByLabel('Priority', { exact: true });
    await expect(status.locator('option')).toHaveText(['To do', 'In progress', 'Done', 'Blocked']);
    await title.fill('Blocked task');
    await status.selectOption('Blocked');
    await priority.selectOption('High');
    const refused = await clickAndAwaitPost(
      page,
      form.getByRole('button', { name: 'Save', exact: true }),
      '/tasks/new',
    );
    expect(refused.status()).toBe(422);

    await expect(status).toHaveValue('Blocked');
    await expect(status.locator('option:checked')).toHaveText('Blocked (invalid)');
    await expect(status.locator('option')).toHaveText([
      'To do',
      'In progress',
      'Done',
      'Blocked (invalid)',
    ]);
    await expectInlineError(status, 'Choose a valid status.');
    // The status is the only invalid field, so it alone is listed and it takes the focus.
    const summary = form.getByRole('region', { name: 'The task was not saved', exact: true });
    await expect(summary.getByRole('link')).toHaveText(['Choose a valid status.']);
    await expect(summary.getByRole('link')).toHaveAttribute('href', '#status');
    await expect(status).toBeFocused();
    await expect(title).toHaveValue('Blocked task');
    await expect(priority).toHaveValue('High');
    expect(await userTasks(email)).toEqual([]);
  });
});

/**
 * Account flows in the browser: sign-up and the first login (SC1), the generic invalid-credential
 * message and the login lockout (SC2), the duplicate-email, invalid-credential and lockout states
 * (SC11), logout with the preserved return path, and Back after logout, which must not restore a
 * signed-in page from the back/forward cache.
 *
 * Every test signs up its own user with a fresh email, so tests share no data and can run in
 * parallel workers. Only rules that need no waiting are exercised: the 15-minute refusal expiry
 * and the session idle and absolute timeouts are proven with a fake clock in the integration
 * suite, never by waiting here.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';

import { logIn, newPassword, signUp, signUpAndLogIn, uniqueEmail } from './support';

const ACCOUNT_CREATED = 'Your account has been created. Log in to continue.';
const NO_TASKS = 'You have no tasks yet.';
const DUPLICATE_EMAIL = 'An account with this email already exists.';
const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const LOCKED_OUT = 'Too many failed attempts. Try again later.';

/**
 * Failed logins for one email that still get the generic message; the attempt after them is the
 * first one refused, whatever its password. The requirement's number is written here rather than
 * imported from the server, so a change to the server's threshold fails this spec.
 */
const FAILURES_BEFORE_LOCKOUT = 5;

/** The session cookie, which only a successful login sets. */
const SESSION_COOKIE = 'sid';

/**
 * Waits for the response to the next `method` request for `pathname`. Callers register it before
 * the click that sends the request, so a fast response cannot be missed.
 */
function responseTo(page: Page, method: string, pathname: string): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === method && new URL(r.url()).pathname === pathname,
  );
}

function logInForm(page: Page): Locator {
  return page.locator('form[action="/login"]');
}

/**
 * Opens a fresh `/login`, submits `email` and `password` and returns the status of the `POST`.
 *
 * A re-rendered login page has the same URL as the page it replaces, so every attempt starts from
 * a page that shows no message: a message the caller then sees can only belong to the page this
 * submission produced, and no field is filled before that page has replaced its predecessor.
 */
async function submitLogIn(page: Page, email: string, password: string): Promise<number> {
  await page.goto('/login');
  const form = logInForm(page);
  await form.getByLabel('Email', { exact: true }).fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  const response = responseTo(page, 'POST', '/login');
  await form.getByRole('button', { name: 'Log in', exact: true }).click();
  return (await response).status();
}

/**
 * Asserts a refused login as the browser shows it: `message` is visible, the page is still
 * `/login` with no redirect, and the password field is empty, because passwords are never echoed.
 */
async function expectLogInRefused(page: Page, message: string): Promise<void> {
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page).toHaveURL((u) => u.pathname === '/login' && u.search === '');
  await expect(logInForm(page).getByLabel('Password', { exact: true })).toHaveValue('');
}

/**
 * Asserts that the browser holds no session: there is no session cookie, and the task list
 * answers 302 to the login page carrying its encoded return path, `/login?next=%2Ftasks`.
 * Leaves the page on that login page.
 */
async function expectSignedOut(page: Page): Promise<void> {
  const cookieNames = (await page.context().cookies()).map((c) => c.name);
  expect(cookieNames).not.toContain(SESSION_COOKIE);

  const landed = await page.goto('/tasks');
  const redirect = await landed?.request().redirectedFrom()?.response();
  expect(redirect?.status()).toBe(302);
  const url = new URL(page.url());
  expect(url.pathname + url.search).toBe('/login?next=%2Ftasks');
}

test.describe('accounts in the browser', () => {
  test('signs up, then logs in to an empty task list', async ({ page }) => {
    const email = uniqueEmail();
    const password = newPassword();

    await signUp(page, email, password);
    await expect(page.getByText(ACCOUNT_CREATED, { exact: true })).toBeVisible();

    await logIn(page, email, password);
    await expect(page.getByText(NO_TASKS, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create a task', exact: true })).toHaveAttribute(
      'href',
      '/tasks/new',
    );
    await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible();
  });

  test('rejects a duplicate email', async ({ page }) => {
    const email = uniqueEmail();
    await signUp(page, email, newPassword());

    // Uniqueness ignores case, so the address with its local part upper-cased is a duplicate.
    const sameEmailOtherCase = email.replace(/^[^@]+/, (local) => local.toUpperCase());
    await page.goto('/signup');
    const form = page.locator('form[action="/signup"]');
    await form.getByLabel('Email', { exact: true }).fill(sameEmailOtherCase);
    await form.getByLabel('Password', { exact: true }).fill(newPassword());
    const response = responseTo(page, 'POST', '/signup');
    await form.getByRole('button', { name: 'Create account', exact: true }).click();
    expect((await response).status()).toBe(409);

    await expect(page.getByText(DUPLICATE_EMAIL, { exact: true })).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === '/signup');
    await expect(form.getByLabel('Email', { exact: true })).toHaveValue(sameEmailOtherCase);
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('');
  });

  test('shows the same generic message for a wrong password and an unknown email', async ({
    page,
  }) => {
    const email = uniqueEmail();
    await signUp(page, email, newPassword());

    expect(await submitLogIn(page, email, newPassword()), 'wrong password').toBe(422);
    await expectLogInRefused(page, INVALID_CREDENTIALS);

    expect(await submitLogIn(page, uniqueEmail('unknown'), newPassword()), 'unknown email').toBe(
      422,
    );
    await expectLogInRefused(page, INVALID_CREDENTIALS);
  });

  test('refuses the correct password after five failures', async ({ page }) => {
    // Sign-up and the five failed credential checks use cost-12 bcrypt; the locked attempt
    // skips it.
    test.setTimeout(60_000);
    const email = uniqueEmail();
    const password = newPassword();
    await signUp(page, email, password);

    for (let attempt = 1; attempt <= FAILURES_BEFORE_LOCKOUT; attempt += 1) {
      const status = await submitLogIn(page, email, newPassword());
      expect(status, `failed attempt ${attempt}`).toBe(422);
      await expectLogInRefused(page, INVALID_CREDENTIALS);
    }

    expect(await submitLogIn(page, email, password), 'correct password while locked').toBe(429);
    await expectLogInRefused(page, LOCKED_OUT);
    await expectSignedOut(page);
  });

  test('logs out and protects the task list', async ({ page }) => {
    const user = await signUpAndLogIn(page);

    const logout = responseTo(page, 'POST', '/logout');
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    expect((await logout).status()).toBe(303);
    await expect(page).toHaveURL((u) => u.pathname === '/login' && u.search === '');
    await expectSignedOut(page);
    await expect(logInForm(page).locator('input[name="next"]')).toHaveValue('/tasks');

    // A path other than the default `/tasks` proves the login returns to the page asked for:
    // the guard carries the path and query in `next`, and the login form posts it back.
    const requested = '/tasks?status=Done';
    await page.goto(requested);
    await expect(page).toHaveURL(
      (u) => u.pathname === '/login' && u.searchParams.get('next') === requested,
    );
    await expect(logInForm(page).locator('input[name="next"]')).toHaveValue(requested);

    await logIn(page, user.email, user.password, requested);
    await expect(page.getByText(`Signed in as ${user.email}`, { exact: true })).toBeVisible();
  });

  test('Back after logout requests the task list again instead of restoring it', async ({
    playwright,
    baseURL,
  }) => {
    // Playwright starts Chromium with `--disable-back-forward-cache`, and its default headless
    // shell has no back/forward cache at all. Launch options cannot change for a single test, so
    // this test launches its own full Chromium (the `chromium` channel, new headless mode) with
    // the cache on, as a user's Chrome has it. `launch` keeps the other configured options.
    const browser = await playwright.chromium.launch({
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    });
    try {
      const page = await (await browser.newContext({ baseURL })).newPage();
      await signUpAndLogIn(page);

      const logout = responseTo(page, 'POST', '/logout');
      await page.getByRole('button', { name: 'Log out', exact: true }).click();
      const logoutResponse = await logout;
      expect(logoutResponse.status()).toBe(303);
      await expect(page).toHaveURL((u) => u.pathname === '/login' && u.search === '');

      // A page restored from the back/forward cache fires no load event and sends no request, so
      // the navigation is awaited only until it commits, and a restore yields no response.
      const back = await page.goBack({ waitUntil: 'commit' });
      await expect(page.getByText('Signed in as')).toBeHidden();
      expect(back, 'Back must reach the server, not the back/forward cache').not.toBeNull();
      const redirected = back?.request().redirectedFrom() ?? null;
      expect(redirected && new URL(redirected.url()).pathname).toBe('/tasks');
      expect((await redirected?.response())?.status()).toBe(302);
      await expect(page).toHaveURL((u) => u.pathname + u.search === '/login?next=%2Ftasks');
      await expect(logInForm(page)).toBeVisible();
      expect(await logoutResponse.headerValue('clear-site-data')).toBe('"cache"');
    } finally {
      await browser.close();
    }
  });
});

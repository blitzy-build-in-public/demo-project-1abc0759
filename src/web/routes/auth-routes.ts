/**
 * Sign-up, login and logout routes.
 *
 * Every handler checks in one order: the auth guard, then the CSRF token, then the form, and only
 * then calls the auth service. Expected outcomes (an invalid form, a duplicate email, invalid
 * credentials, a lockout) are rendered here; CSRF failures, malformed requests and database
 * failures are passed to the error handler, which owns those pages and all logging.
 */

import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';

import type { AuthService, LogInResult, SignUpResult } from '../../auth/auth-service';
import type { AppConfig } from '../../config';
import { asyncHandler } from '../async-handler';
import { CSRF_COOKIE, SESSION_COOKIE, clearCookieOptions, sessionCookieOptions } from '../cookies';
import { csrfTokenOf, type Csrf } from '../csrf';
import { requireAnonymous } from '../middleware/require-auth';
import '../request-user';
import { sanitizeReturnPath } from '../return-path';
import { renderLogInPage, renderSignUpPage } from '../templates/auth-pages';
import {
  AUTH_FIELDS,
  DUPLICATE_EMAIL_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  LOCKOUT_MESSAGE,
  parseLogInForm,
  parseSignUpForm,
  readAuthFormValues,
} from '../validation/auth-forms';
import type { AuthFormValues } from '../validation/auth-forms';

/** Inline messages the sign-up page shows beside its fields. */
type SignUpErrors = { email?: string; password?: string };

/** A rendered rejection: the HTTP status and the content that goes with it. */
interface Rejection<T> {
  status: number;
  content: T;
}

/** Sends a complete HTML page with `Content-Type: text/html; charset=utf-8`. */
function sendHtml(res: Response, status: number, page: string): void {
  res.status(status).type('html').send(page);
}

/**
 * Returns the raw session token from a validly signed `sid` cookie, or `null`.
 *
 * Express types `req.signedCookies` as `any`, and cookie-parser stores `false` there for a bad
 * signature, so the jar is narrowed before use. Only own properties count, so an inherited name
 * never passes for a cookie. The token is only handed to the auth service, never logged or
 * rendered.
 */
function readSessionToken(req: Request): string | null {
  const signed: unknown = req.signedCookies;
  if (typeof signed !== 'object' || signed === null || !Object.hasOwn(signed, SESSION_COOKIE)) {
    return null;
  }
  const value: unknown = Reflect.get(signed, SESSION_COOKIE);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether the request presented a `sid` cookie of any kind: validly or badly signed, unsigned or
 * empty. cookie-parser moves a validly signed value to `req.signedCookies`, records a bad
 * signature there as `false` and leaves an unsigned value in `req.cookies`, so both jars are
 * read. Express types them as `any`, so each is narrowed first, and only own properties count.
 */
function presentsSessionCookie(req: Request): boolean {
  const jars: readonly unknown[] = [req.signedCookies, req.cookies];
  return jars.some(
    (jar) => typeof jar === 'object' && jar !== null && Object.hasOwn(jar, SESSION_COOKIE),
  );
}

/**
 * Where a successful sign-up goes: the login page with the account-created notice. The default
 * return path `/tasks` is left off, so the plain location is exactly `/login?created=1`; any
 * other (already sanitised) path is carried on as `next` for the login form.
 */
function signUpCreatedLocation(next: string): string {
  const created = '/login?created=1';
  return next === '/tasks' ? created : `${created}&${AUTH_FIELDS.next}=${encodeURIComponent(next)}`;
}

/**
 * Maps a refused sign-up to its page status and inline messages: a policy failure re-renders
 * with 422, a duplicate email with 409 and the message beside the email field. The switch must
 * cover every reason, because the declared return type admits no fall-through.
 */
function signUpRejection(
  result: Extract<SignUpResult, { ok: false }>,
): Rejection<SignUpErrors> {
  switch (result.reason) {
    case 'invalid':
      return { status: 422, content: result.errors };
    case 'duplicate':
      return { status: 409, content: { email: DUPLICATE_EMAIL_MESSAGE } };
  }
}

/**
 * Maps a refused login to its page status and the login page's single message: 429 for the
 * lockout and 422 for invalid credentials. An unknown email and a wrong password share one
 * reason, so their pages are identical and reveal nothing about which emails have accounts.
 */
function logInRejection(
  reason: Extract<LogInResult, { ok: false }>['reason'],
): Rejection<string> {
  switch (reason) {
    case 'locked':
      return { status: 429, content: LOCKOUT_MESSAGE };
    case 'invalid':
      return { status: 422, content: INVALID_CREDENTIALS_MESSAGE };
  }
}

/**
 * Creates the router for the account pages. It is mounted at the application root after
 * `cookieParser(SESSION_SECRET)`, `express.urlencoded`, `loadSession`, `csrf.prepare` and
 * `noStore`, and declares full paths:
 *
 * - `GET /signup` (anonymous only): 200 sign-up page, carrying the sanitised `next` query value.
 * - `POST /signup` (anonymous only; CSRF bound to `anon`): 303 to `/login?created=1`, with `next`
 *   carried when it is not `/tasks`; 422 with inline messages when the email or password fails
 *   its policy; 409 "An account with this email already exists." with the entered email kept.
 * - `GET /login` (anonymous only): 200 login page, with the account-created notice when
 *   `created=1` and the sanitised `next` in a hidden field.
 * - `POST /login` (anonymous only; CSRF bound to `anon`): 303 to the sanitised `next` (default
 *   `/tasks`), setting the signed `sid` cookie; 422 "Email or password is incorrect."; 429 "Too
 *   many failed attempts. Try again later."
 * - `POST /logout` (CSRF bound to the session when one is active): deletes the session row,
 *   clears `sid` and the `csrf` nonce, sends `Clear-Site-Data: "cache"` and answers 303 to
 *   `/login`. Without a session it skips the CSRF check and clears the same way when the request
 *   presented a `sid`; a request that presented none gets the bare 303 and changes nothing.
 *
 * "Anonymous only" means a signed-in request is redirected to `/tasks` by `requireAnonymous`
 * before its CSRF token is checked. A CSRF failure reaches the error handler as `CsrfError`
 * (403), a repeated or non-string field as `BadRequestError` (400), and a service rejection such
 * as `DatabaseUnavailableError` (503) through {@link asyncHandler}; nothing is changed in any of
 * these cases. Passwords are never re-rendered, and the session token appears only in
 * `Set-Cookie`.
 *
 * @param deps - `auth`, the auth service; `config`, whose `isProduction` adds `Secure` to the
 *   session cookie; `csrf`, the application's CSRF middleware, whose `prepare` has already run.
 * @returns An Express router with the five account routes.
 */
export function createAuthRouter(deps: {
  auth: AuthService;
  config: AppConfig;
  csrf: Csrf;
}): Router {
  const { auth, config, csrf } = deps;
  // Exact matching, as the application sets for itself: a router does not inherit it, and
  // `/LOGIN` or `/signup/` must reach the 404 handler rather than a route.
  const router = express.Router({ caseSensitive: true, strict: true });

  // Every page renders the token `csrf.prepare` bound to `anon` for this anonymous response.
  function renderSignUp(
    res: Response,
    status: number,
    values: AuthFormValues,
    errors: SignUpErrors,
  ): void {
    sendHtml(res, status, renderSignUpPage({ csrfToken: csrfTokenOf(res), values, errors }));
  }

  function renderLogIn(
    res: Response,
    status: number,
    values: AuthFormValues,
    created: boolean,
    message?: string,
  ): void {
    const view = { csrfToken: csrfTokenOf(res), values, created, message };
    sendHtml(res, status, renderLogInPage(view));
  }

  router.get('/signup', requireAnonymous, (req: Request, res: Response): void => {
    const values = { email: '', next: sanitizeReturnPath(req.query[AUTH_FIELDS.next]) };
    renderSignUp(res, 200, values, {});
  });

  router.post(
    '/signup',
    requireAnonymous,
    csrf.verify('anon'),
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const body: unknown = req.body;
      const parsed = parseSignUpForm(body);
      if (!parsed.ok) {
        renderSignUp(res, 422, parsed.values, {
          email: parsed.errors.email,
          password: parsed.errors.password,
        });
        return;
      }

      const result = await auth.signUp(parsed.value);
      // The success branch of the parse result carries only the credentials, so the entered
      // email and the sanitised return path are read again for the re-render or the redirect.
      const values = readAuthFormValues(body);
      if (result.ok) {
        res.redirect(303, signUpCreatedLocation(values.next));
        return;
      }
      const rejection = signUpRejection(result);
      renderSignUp(res, rejection.status, values, rejection.content);
    }),
  );

  router.get('/login', requireAnonymous, (req: Request, res: Response): void => {
    const values = { email: '', next: sanitizeReturnPath(req.query[AUTH_FIELDS.next]) };
    renderLogIn(res, 200, values, req.query.created === '1');
  });

  router.post(
    '/login',
    requireAnonymous,
    csrf.verify('anon'),
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const body: unknown = req.body;
      const parsed = parseLogInForm(body);
      if (!parsed.ok) {
        // A blank email or password gets the generic message without calling the service, so
        // it is never recorded as a failed attempt and never counts towards the lockout.
        renderLogIn(res, 422, parsed.values, false, INVALID_CREDENTIALS_MESSAGE);
        return;
      }

      // The service alone decides a lockout and checks no password while one holds, so the
      // refusal stands even when the submitted password is correct.
      const result = await auth.logIn(parsed.value);
      const values = readAuthFormValues(body);
      if (result.ok) {
        // The service issues a fresh token at every login, which prevents session fixation.
        // `values.next` is already sanitised, so the redirect cannot leave this origin.
        res.cookie(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(config));
        res.redirect(303, values.next);
        return;
      }
      const rejection = logInRejection(result.reason);
      renderLogIn(res, rejection.status, values, false, rejection.content);
    }),
  );

  const verifySessionCsrf = csrf.verify('session');
  // Logout from an active session is a state change and needs the session-bound token. Without
  // a session there is nothing to delete, so the token is not required and the request only
  // clears cookies when it presented a `sid`: a stale tab's Log out button still signs it out.
  const verifyLogoutCsrf: RequestHandler = (req, res, next): void => {
    if (req.user === undefined) {
      next();
      return;
    }
    verifySessionCsrf(req, res, next);
  };

  router.post(
    '/logout',
    verifyLogoutCsrf,
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const token = req.user === undefined ? null : readSessionToken(req);
      if (token !== null) {
        await auth.logOut(token);
      }
      // Only a `sid` the request presented is cleared. A request without one, such as a
      // cross-site form that `SameSite=Lax` sends without cookies, must change nothing, so its
      // response never expires the session cookie the browser still holds.
      if (presentsSessionCookie(req)) {
        const clearOptions = clearCookieOptions(config);
        res.clearCookie(SESSION_COOKIE, clearOptions);
        // Chrome keeps `no-store` pages in its back/forward cache and restores them even after
        // `sid` is deleted, though not once a cookie has been set. Clearing `csrf` makes the
        // login page this redirects to set a fresh nonce, so Back after logout asks the server
        // again. `Clear-Site-Data: "cache"` evicts the pages cached before this one; it also
        // empties the origin's HTTP cache, which holds only static assets.
        res.clearCookie(CSRF_COOKIE, clearOptions);
        res.set('Clear-Site-Data', '"cache"');
      }
      res.redirect(303, '/login');
    }),
  );

  return router;
}

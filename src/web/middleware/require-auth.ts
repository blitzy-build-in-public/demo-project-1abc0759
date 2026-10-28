/**
 * Route guards keyed to whether the request is signed in.
 *
 * Both guards read only `req.user`, which `loadSession` sets for a validly signed, active session
 * and leaves absent otherwise, so both must run after `loadSession`. Each guard is listed first in
 * its route's handler chain, ahead of `csrf.verify`: whether the request may reach the route at all
 * is decided before its form token is checked.
 *
 * Status codes follow one rule. `GET` and `HEAD` are redirected with 302; any other method with
 * 303, so the browser follows with a `GET` and never re-submits the form body.
 */

import type { Request, RequestHandler } from 'express';

import { loginRedirectFor } from '../return-path';
import '../request-user';

/** Where a signed-in user is sent when requesting a page meant for anonymous visitors. */
const SIGNED_IN_HOME = '/tasks';

/** Whether the request is a safe, replayable page request. Express upper-cases `req.method`. */
function isGetOrHead(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/**
 * Admits only signed-in requests; must run after `loadSession`.
 *
 * When `req.user` is absent (no cookie, a bad signature, an unknown token or an expired session),
 * the request ends here with a redirect to the login page and `next` is not called:
 * - `GET` and `HEAD`: 302 to `/login?next=<URL-encoded original path and query>`, so the user
 *   returns to the page they asked for after logging in.
 * - Any other method: 303 to `/login?next=%2Ftasks`, because a state-changing request is never
 *   replayed after login.
 *
 * The location comes from `loginRedirectFor`, which owns the return-path sanitisation; it never
 * carries the session token or any other cookie value.
 *
 * Routers list this guard before `csrf.verify`, so an unauthenticated `POST` with a missing or
 * stale CSRF token receives the login redirect rather than a 403.
 */
export const requireAuth: RequestHandler = (req, res, next): void => {
  if (req.user === undefined) {
    res.redirect(isGetOrHead(req) ? 302 : 303, loginRedirectFor(req));
    return;
  }
  next();
};

/**
 * Admits only anonymous requests, for the "Anonymous" routes `GET`/`POST /signup` and
 * `GET`/`POST /login`; must run after `loadSession`.
 *
 * When `req.user` is set, the request ends here with a redirect to `/tasks` (302 for `GET` and
 * `HEAD`, 303 otherwise) and `next` is not called. Otherwise the request continues.
 *
 * Routers list this guard before `csrf.verify('anon')`: a signed-in user's form token is bound to
 * the session rather than to `anon`, so verifying it first would answer 403 instead of
 * redirecting.
 */
export const requireAnonymous: RequestHandler = (req, res, next): void => {
  if (req.user !== undefined) {
    res.redirect(isGetOrHead(req) ? 302 : 303, SIGNED_IN_HOME);
    return;
  }
  next();
};

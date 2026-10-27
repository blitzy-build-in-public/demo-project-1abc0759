/**
 * Session loading: resolves the signed `sid` cookie to `req.user` on every non-static request.
 *
 * This middleware is the only place `req.user` is set. CSRF binding, `noStore`, `requireAuth` and
 * the routers all read it afterwards. Token hashing, the expiry check and the activity update live
 * behind `AuthService.authenticate`, so this file issues no query and applies no expiry rule of
 * its own.
 */

import type { RequestHandler } from 'express';
import type { AuthService } from '../../auth/auth-service';
import type { AppConfig } from '../../config';
import { asyncHandler } from '../async-handler';
import { SESSION_COOKIE, clearCookieOptions } from '../cookies';
import '../request-user';

/**
 * Reads one cookie from a jar that cookie-parser populated.
 *
 * Express types `req.cookies` and `req.signedCookies` as `any`, so the jar is taken as `unknown`
 * and the result is narrowed by the caller. Only own properties count: cookie-parser builds its
 * jars with `Object.create(null)`, and an inherited name must never pass for a cookie.
 *
 * @param jar - `req.cookies` or `req.signedCookies`.
 * @param name - The cookie name.
 * @returns The parsed value (a string, `false` for a bad signature, or an object for a `j:`
 *   value), or `undefined` when the jar is missing or holds no cookie of that name.
 */
function readCookie(jar: unknown, name: string): unknown {
  if (typeof jar !== 'object' || jar === null || !Object.hasOwn(jar, name)) {
    return undefined;
  }
  return (jar as Record<string, unknown>)[name];
}

/**
 * Creates the middleware that turns the session cookie into `req.user`.
 *
 * It must be mounted after `cookieParser(SESSION_SECRET)`, which verifies the `sid` signature and
 * moves a validly signed value from `req.cookies` to `req.signedCookies`. Each request ends in one
 * of three outcomes, and always continues with `next()`:
 * - **Anonymous:** no `sid` cookie. Nothing is queried and no cookie is set.
 * - **Cleared:** a bad signature, an unsigned or non-string `sid`, or a token that
 *   `AuthService.authenticate` rejects as unknown or expired. The cookie is cleared with the
 *   attributes it was set with, and the request continues without `req.user`, so protected routes
 *   redirect to `/login` through `requireAuth`.
 * - **Authenticated:** an active session. `req.user` is set to `{ id, email, sessionId }`, and the
 *   request has been recorded as session activity.
 *
 * A rejection from `authenticate`, such as `DatabaseUnavailableError`, is forwarded by
 * {@link asyncHandler} to the error handler (503 "Service temporarily unavailable"). The cookie is
 * then left in place, because the session may still be valid once the database is back.
 *
 * The token is never logged, rendered or stored on `res.locals`.
 *
 * @param auth - The auth service that authenticates the raw session token.
 * @param config - The application configuration; `isProduction` adds `Secure` when clearing.
 * @returns An Express request handler.
 */
export function loadSession(auth: AuthService, config: AppConfig): RequestHandler {
  // One options object serves every request, so it is frozen to keep any request from altering
  // what the next one clears with.
  const clearOptions = Object.freeze(clearCookieOptions(config));

  return asyncHandler(async (req, res, next) => {
    const signed = readCookie(req.signedCookies, SESSION_COOKIE);
    const unsigned = readCookie(req.cookies, SESSION_COOKIE);

    if (signed === undefined && unsigned === undefined) {
      next();
      return;
    }

    // A bad cookie signature skips both session queries: the value cannot be a token this server
    // issued, so it is cleared without reaching the database. An unsigned `sid`, or a signed
    // value that is not a non-empty string, is treated the same way.
    if (unsigned !== undefined || typeof signed !== 'string' || signed === '') {
      res.clearCookie(SESSION_COOKIE, clearOptions);
      next();
      return;
    }

    const user = await auth.authenticate(signed);
    if (user === null) {
      res.clearCookie(SESSION_COOKIE, clearOptions);
    } else {
      req.user = user;
    }
    // Kept out of any try/catch: wrapping it would catch downstream failures here and could call
    // `next` twice.
    next();
  });
}

/**
 * Cookie names and attributes for the session and CSRF cookies.
 *
 * Every cookie is `HttpOnly`, `SameSite=Lax` and scoped to `Path=/`, and carries `Secure` exactly
 * when the application runs with `NODE_ENV=production`. Each function returns a fresh options
 * object, so a caller that adjusts the one it receives cannot change what another request gets.
 */

import type { CookieOptions } from 'express';
import type { AppConfig } from '../config';
import { SESSION_ABSOLUTE_MS } from '../auth/session-policy';

/**
 * Name of the session cookie. Its value is the raw session token, signed by `cookie-parser` with
 * an HMAC-SHA256 keyed by `SESSION_SECRET`, and read back from `req.signedCookies`.
 */
export const SESSION_COOKIE = 'sid';

/**
 * Name of the CSRF nonce cookie. Its value is a random base64url nonce, stored unsigned and read
 * from `req.cookies`; its integrity comes from the HMAC form token derived from it.
 */
export const CSRF_COOKIE = 'csrf';

/**
 * Options for setting the session cookie at login.
 *
 * `Max-Age` mirrors only the 8-hour absolute session limit, so the cookie never outlives that cap.
 * The 30-minute idle expiry is enforced server-side, so the session can end earlier while the
 * browser still holds the cookie; the server then rejects that cookie and clears it. Express
 * converts the millisecond `maxAge` into `Max-Age=28800` plus a matching `Expires`. Signing
 * requires the app to mount `cookieParser(SESSION_SECRET)`.
 *
 * @param config - The application configuration; `isProduction` adds `Secure`.
 * @returns `HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`, signed, plus `Secure` in production.
 */
export function sessionCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_ABSOLUTE_MS,
    signed: true,
    secure: config.isProduction,
  };
}

/**
 * Options for setting the CSRF nonce cookie.
 *
 * It has no `Max-Age` or `Expires`, so it lives for the browser session, and it is not signed.
 *
 * @param config - The application configuration; `isProduction` adds `Secure`.
 * @returns `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in production.
 */
export function csrfCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.isProduction,
  };
}

/**
 * Options for clearing a cookie with `res.clearCookie(name, clearCookieOptions(config))`.
 *
 * A browser deletes a cookie only when the clearing `Set-Cookie` matches its `Path`, so these
 * repeat the `path`, `httpOnly`, `sameSite` and `secure` attributes used to set it. They are kept
 * apart from {@link sessionCookieOptions} on purpose: Express 4's `res.clearCookie` expires the
 * cookie by setting `Expires` to the epoch, and a `maxAge` in its options would override that
 * (and is deprecated for `clearCookie` since Express 4.20), while `signed` is meaningless for the
 * empty value written when clearing.
 *
 * @param config - The application configuration; `isProduction` adds `Secure`.
 * @returns `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in production, with no `maxAge`,
 *   `expires` or `signed`.
 */
export function clearCookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.isProduction,
  };
}

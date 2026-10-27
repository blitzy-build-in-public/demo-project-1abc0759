/**
 * CSRF protection: an HMAC-signed double-submit token bound to the session.
 *
 * - The `csrf` cookie holds a random 32-byte base64url nonce, issued by {@link Csrf.prepare} to
 *   any request that arrives without a well-formed one.
 * - Every `POST` form carries a hidden {@link CSRF_FIELD} whose value is
 *   `base64url(HMAC-SHA256(SESSION_SECRET, "csrf|" + binding + "|" + nonce))`.
 * - `binding` is the signed-in user's `sessionId` (the hex session-token hash) for authenticated
 *   forms, and the literal `anon` for the sign-up and login forms, which are always verified
 *   against `anon` so login itself is protected.
 *
 * A forged request cannot carry a valid token: a cross-site page can neither read the `HttpOnly`
 * nonce cookie nor compute the HMAC without the secret, and a token rendered for one session
 * fails for any other. `SESSION_SECRET` also keys cookie-parser's cookie signatures; the `csrf|`
 * message prefix keeps the two uses apart. Rotating the secret invalidates every outstanding form.
 *
 * No CSRF package is used (csurf is archived); `node:crypto` covers the whole mechanism.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config';
import { CsrfError } from '../shared/errors';
import { CSRF_COOKIE, csrfCookieOptions } from './cookies';
import './request-user';

/** Name of the hidden form field that carries the CSRF token on every `POST` form. */
export const CSRF_FIELD = '_csrf';

/** Random bytes in a nonce: 256 bits. */
const NONCE_BYTES = 32;

/** 32 bytes in unpadded base64url are exactly 43 characters from the URL-safe alphabet. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Binding for forms rendered without a session: sign-up and login. */
const ANON_BINDING = 'anon';

/** Domain separator for the HMAC message, distinct from cookie-parser's cookie signatures. */
const TOKEN_PREFIX = 'csrf|';

/**
 * Which value a protected route binds its token to: `anon` for the sign-up and login forms,
 * `session` for every form posted from a signed-in session.
 */
export type CsrfBinding = 'anon' | 'session';

/** The CSRF middleware and token function created once per application by {@link createCsrf}. */
export interface Csrf {
  /**
   * Middleware mounted for every non-static request, after `cookieParser` and `loadSession`.
   *
   * It reads the `csrf` nonce cookie; when the cookie is absent or malformed it generates a new
   * nonce and sets the cookie on the response. It then sets `res.locals.csrfNonce` to the nonce
   * and `res.locals.csrfToken` to the token for that nonce, bound to `req.user.sessionId` when a
   * user is signed in and to `anon` otherwise, and calls `next()`. A newly issued nonce is used
   * for the token at once, so the first page a browser receives already carries a working form.
   */
  prepare: RequestHandler;

  /**
   * Builds the middleware that guards one state-changing route.
   *
   * The request passes only when its `csrf` cookie holds a well-formed nonce, its body holds
   * exactly one {@link CSRF_FIELD} string, and that string equals the token for the nonce and the
   * binding, compared in constant time. The binding is `anon` for `'anon'`, and
   * `req.user.sessionId` for `'session'`, which fails when no user is signed in. Any missing
   * piece or mismatch calls `next(new CsrfError())` (403 "The form has expired. Reload the page
   * and try again."), so the route handler never runs and nothing changes. The token, nonce and
   * body are never logged or echoed.
   *
   * @param binding - `'anon'` for `POST /signup` and `POST /login`; `'session'` for every
   *   signed-in form, including `POST /logout` when a session is active.
   * @returns Synchronous middleware that calls `next()` or `next(new CsrfError())`.
   */
  verify(binding: CsrfBinding): RequestHandler;

  /**
   * Computes the form token `base64url(HMAC-SHA256(secret, "csrf|" + binding + "|" + nonce))`.
   *
   * @param nonce - The base64url nonce from the `csrf` cookie.
   * @param binding - `anon`, or the hex `sessionId` of the signed-in session.
   * @returns The 43-character base64url token.
   */
  tokenFor(nonce: string, binding: string): string;
}

/**
 * Returns `container[key]` when `container` is an object holding `key` as an own string property,
 * otherwise `null`. Only own properties count, so a name inherited from a prototype is never
 * mistaken for a submitted value. A repeated form field arrives as an array and is rejected.
 */
function ownString(container: unknown, key: string): string | null {
  if (typeof container !== 'object' || container === null || !Object.hasOwn(container, key)) {
    return null;
  }
  const value: unknown = Reflect.get(container, key);
  return typeof value === 'string' ? value : null;
}

/**
 * Returns the well-formed nonce from the `csrf` cookie the browser sent, or `null`. Express types
 * `req.cookies` as `any`, and cookie-parser may JSON-decode a `j:` value into an object, so the
 * value is narrowed before use.
 */
function readNonce(req: Request): string | null {
  const cookies: unknown = req.cookies;
  const raw = ownString(cookies, CSRF_COOKIE);
  return raw !== null && NONCE_PATTERN.test(raw) ? raw : null;
}

/**
 * Creates the CSRF middleware for one application.
 *
 * @param secret - `SESSION_SECRET`, the HMAC key (at least 32 characters, enforced by
 *   `loadConfig`).
 * @param config - The application configuration; `isProduction` adds `Secure` to the nonce
 *   cookie.
 * @returns The {@link Csrf} middleware and token function.
 */
export function createCsrf(secret: string, config: AppConfig): Csrf {
  // Neither part of the message can contain `|`: a nonce is base64url and a binding is `anon` or
  // lowercase hex, so every (binding, nonce) pair yields a distinct message.
  function tokenFor(nonce: string, binding: string): string {
    return createHmac('sha256', secret)
      .update(TOKEN_PREFIX + binding + '|' + nonce)
      .digest('base64url');
  }

  function isAuthentic(req: Request, binding: CsrfBinding): boolean {
    const nonce = readNonce(req);
    if (nonce === null) {
      return false;
    }
    const bindingValue = binding === 'anon' ? ANON_BINDING : req.user?.sessionId;
    // Routers run `requireAuth` before a session-bound check, so a missing user is unreachable in
    // practice; it still fails closed rather than falling back to another binding.
    if (bindingValue === undefined || bindingValue === '') {
      return false;
    }
    const body: unknown = req.body;
    const submitted = ownString(body, CSRF_FIELD);
    if (submitted === null) {
      return false;
    }
    const expected = Buffer.from(tokenFor(nonce, bindingValue), 'utf8');
    const actual = Buffer.from(submitted, 'utf8');
    // `timingSafeEqual` throws on buffers of unequal length. Every token has the same length, so
    // checking it first reveals nothing about the expected value.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  const prepare: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    let nonce = readNonce(req);
    if (nonce === null) {
      nonce = randomBytes(NONCE_BYTES).toString('base64url');
      res.cookie(CSRF_COOKIE, nonce, csrfCookieOptions(config));
      // `req.cookies` is deliberately left untouched: `verify` must judge only the cookie the
      // browser actually sent, so a POST that arrives without one always fails.
    }
    res.locals.csrfNonce = nonce;
    res.locals.csrfToken = tokenFor(nonce, req.user ? req.user.sessionId : ANON_BINDING);
    next();
  };

  function verify(binding: CsrfBinding): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction): void => {
      if (isAuthentic(req, binding)) {
        next();
      } else {
        next(new CsrfError());
      }
    };
  }

  return { prepare, verify, tokenFor };
}

/**
 * Returns the CSRF token {@link Csrf.prepare} rendered for this response, for the hidden
 * {@link CSRF_FIELD} of every form on the page, including the layout's logout form.
 *
 * @param res - The current response.
 * @returns `res.locals.csrfToken`, or `''` when `prepare` did not run for this response (the
 *   `/static` 404 page, which renders no form).
 */
export function csrfTokenOf(res: Response): string {
  const token: unknown = res.locals.csrfToken;
  return typeof token === 'string' ? token : '';
}

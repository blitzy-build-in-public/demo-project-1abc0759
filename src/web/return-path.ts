/**
 * Return-path handling for the login flow.
 *
 * An unauthenticated request for a protected page is sent to `/login?next=<path>`, and a successful
 * login redirects to that `next` value. `next` arrives in a query string or a form field, so it is
 * attacker-controlled: {@link sanitizeReturnPath} reduces it to a same-origin relative path or to
 * {@link DEFAULT_RETURN_PATH}, so it can never become an open redirect. Both functions are pure.
 */

import type { Request } from 'express';

/** Where a user lands after login when no acceptable return path was supplied. */
export const DEFAULT_RETURN_PATH = '/tasks';

/** Longest return path accepted, in UTF-16 code units, both as submitted and once normalised. */
export const MAX_RETURN_PATH_LENGTH = 2048;

/**
 * Fixed base that candidate paths are resolved against. It is never fetched: it only lets the
 * WHATWG URL parser tell a same-origin path from one that escapes to another host. The `.invalid`
 * top-level domain is reserved and never resolves.
 */
const INTERNAL_BASE = 'http://return-path.invalid';

/** Origin of {@link INTERNAL_BASE}; a resolved candidate must keep exactly this origin. */
const INTERNAL_ORIGIN = new URL(INTERNAL_BASE).origin;

/**
 * Auth pages that are never a return target. Returning to `/login` or `/signup` would send the
 * user back to the form just completed, and `/logout` only accepts `POST`.
 */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set(['/login', '/signup', '/logout']);

/**
 * Any Unicode control character: C0 (U+0000–U+001F), DEL (U+007F) and C1 (U+0080–U+009F).
 * C1 is included because the rule is "no control characters", not only the ASCII ones.
 */
const CONTROL_CHAR = /\p{Cc}/u;

/** Login location for requests that are not `GET` or `HEAD`: `/login?next=%2Ftasks`. */
const NON_REPLAYABLE_LOGIN_REDIRECT = `/login?next=${encodeURIComponent(DEFAULT_RETURN_PATH)}`;

/**
 * Whether `value` begins with exactly one `/`. A leading `//` or `/\` is read by browsers as a
 * protocol-relative URL pointing at another host.
 */
function startsWithSingleSlash(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\');
}

/**
 * Whether a resolved pathname reaches one of {@link EXCLUDED_PATHS}. Express routing is
 * case-insensitive and non-strict by default, so `/LOGIN` and `/login/` reach the login route too:
 * the comparison lower-cases the path and drops one trailing slash.
 */
function isExcludedTarget(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  const trimmed = lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
  return EXCLUDED_PATHS.has(trimmed);
}

/**
 * Reduces an untrusted return-path value to a safe same-origin path.
 *
 * The value is accepted only when every rule holds, checked in this order:
 * 1. It is a string of 1 to {@link MAX_RETURN_PATH_LENGTH} characters. A repeated `next`
 *    parameter (an array), `undefined` and every other type are rejected.
 * 2. It begins with exactly one `/`, so `//evil.example` and `/\evil.example` are rejected.
 * 3. It contains no backslash and no control character. This runs before URL parsing because the
 *    WHATWG parser silently strips tab, CR and LF and reads `\` as `/`.
 * 4. It parses against a fixed internal base and keeps that base's origin.
 * 5. Its resolved pathname, lower-cased and without one trailing `/`, is not `/login`, `/signup`
 *    or `/logout`. Resolving first defeats dot segments such as `/tasks/../login`.
 * 6. Its normalised form (pathname and query, fragment dropped) still begins with exactly one `/`
 *    and is at most {@link MAX_RETURN_PATH_LENGTH} characters long.
 *
 * @param raw - The submitted `next` value, from a query string, a form body or `req.originalUrl`.
 * @returns The normalised `pathname + search` of an accepted value, otherwise
 *   {@link DEFAULT_RETURN_PATH}. The result is always an ASCII, same-origin relative path, safe to
 *   pass to `res.redirect(303, …)` and to `encodeURIComponent`.
 */
export function sanitizeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) {
    return DEFAULT_RETURN_PATH;
  }
  if (!startsWithSingleSlash(raw)) {
    return DEFAULT_RETURN_PATH;
  }
  if (raw.includes('\\') || CONTROL_CHAR.test(raw)) {
    return DEFAULT_RETURN_PATH;
  }

  let url: URL;
  try {
    url = new URL(raw, INTERNAL_BASE);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  if (url.origin !== INTERNAL_ORIGIN || isExcludedTarget(url.pathname)) {
    return DEFAULT_RETURN_PATH;
  }

  // Rule 6 closes two gaps the input checks cannot see: dot segments can collapse to a leading
  // `//` (`/.//evil.example` resolves to `//evil.example`, a protocol-relative redirect), and
  // percent-encoding non-ASCII characters can push the value past the length limit.
  const normalized = url.pathname + url.search;
  if (!startsWithSingleSlash(normalized) || normalized.length > MAX_RETURN_PATH_LENGTH) {
    return DEFAULT_RETURN_PATH;
  }
  return normalized;
}

/**
 * Builds the login location for a request that needs authentication. `requireAuth` chooses the
 * status (302 for `GET`/`HEAD`, 303 otherwise); this function only builds the location.
 *
 * - `GET` and `HEAD`: `/login?next=` followed by the URL-encoded, sanitised original path and
 *   query, so `GET /tasks` gives `/login?next=%2Ftasks` and `GET /tasks?status=Done` gives
 *   `/login?next=%2Ftasks%3Fstatus%3DDone`.
 * - Any other method: `/login?next=%2Ftasks`, because a state-changing request is never replayed
 *   after login.
 *
 * @param req - The incoming request; only `method` and `originalUrl` are read.
 * @returns A same-origin location starting with `/login?next=`.
 */
export function loginRedirectFor(req: Request): string {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return `/login?next=${encodeURIComponent(sanitizeReturnPath(req.originalUrl))}`;
  }
  return NON_REPLAYABLE_LOGIN_REDIRECT;
}

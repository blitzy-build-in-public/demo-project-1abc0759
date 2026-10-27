/**
 * Cookie-jar form client for driving the server-rendered application over real HTTP.
 *
 * It wraps Node 20's global `fetch` with `redirect: 'manual'`, keeps a cookie jar fed from
 * `headers.getSetCookie()`, remembers the last HTML page so the `_csrf` hidden field can be
 * re-submitted, and posts URL-encoded forms the way a browser without JavaScript does.
 *
 * The module is runner-neutral: integration suites reach it through the in-process test app, and
 * the performance seed runs it under Playwright against the production-mode container. It imports
 * nothing but `node:crypto`, so {@link signCookieValue} is an independent oracle for
 * cookie-parser's signed-cookie format and the seed never loads database code.
 */

import { createHmac } from 'node:crypto';

/**
 * Name of the hidden CSRF form field, fixed by the session and CSRF model (plan 0.3.4) and
 * rendered by every `POST` form the application serves.
 */
export const CSRF_FIELD_NAME = '_csrf';

/** One HTTP response, fully read. */
export interface HttpResult {
  /** HTTP status code. Redirects are returned as they are, never followed. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /**
   * The body decoded as UTF-8 from {@link HttpResult.bytes}. A leading byte-order mark, as the
   * CSV export sends, is kept as `\uFEFF`.
   */
  body: string;
  /** The raw response body. Empty for `HEAD` requests. */
  bytes: Buffer;
  /** The `Location` header, or `null` when the response has none. */
  location: string | null;
  /** Every `Set-Cookie` header line of the response, unparsed and in order. */
  setCookies: string[];
}

/** The parts of one `Set-Cookie` header line that the tests assert on. */
export interface ParsedSetCookie {
  /** Cookie name, trimmed. */
  name: string;
  /** Cookie value exactly as sent (still URL-encoded), trimmed of surrounding whitespace. */
  value: string;
  /** Whether the `HttpOnly` attribute is present. */
  httpOnly: boolean;
  /** Whether the `Secure` attribute is present. */
  secure: boolean;
  /** The `SameSite` value as written, for example `'Lax'`, or `null` when absent. */
  sameSite: string | null;
  /** The `Path` value, or `null` when absent. */
  path: string | null;
  /**
   * The last valid `Max-Age` value in seconds, or `null` when there is none. A value that is not
   * an integer is ignored (RFC 6265 §5.2.2), so it never erases an earlier valid one.
   */
  maxAge: number | null;
  /**
   * The last parseable `Expires` date, or `null` when there is none. An unparseable value is
   * ignored (RFC 6265 §5.2.1), so it never erases an earlier valid one.
   */
  expires: Date | null;
}

/** Options for {@link HttpClient.post}. */
export interface PostOptions {
  /**
   * The CSRF token to submit: `false` sends none, a string sends that value, and when omitted the
   * client sends the token from the last HTML page, if it holds one.
   */
  csrf?: string | false;
}

/** Headers and body handed to the private request method. */
interface RequestParts {
  headers?: Record<string, string>;
  body?: string;
}

/** One cookie in the jar, identified by name and path; one host-only origin has one domain. */
interface StoredCookie {
  readonly name: string;
  /** The raw value as sent, still URL-encoded. */
  readonly value: string;
  /** The effective path, always starting with `/`. */
  readonly path: string;
}

/** Every `<input …>` tag. The `html` template tag escapes `>` in values, so `[^>]*` is safe. */
const INPUT_TAG = /<input\b[^>]*>/gi;

/** A `name="_csrf"` attribute, in either quote style, in any position within the tag. */
const CSRF_NAME_ATTR = new RegExp(
  `\\sname\\s*=\\s*(?:"${CSRF_FIELD_NAME}"|'${CSRF_FIELD_NAME}')`,
  'i',
);

/** A quoted `value` attribute; group 1 holds a double-quoted value, group 2 a single-quoted one. */
const VALUE_ATTR = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The character references the application's `escapeHtml` produces. */
const HTML_ENTITY = /&(amp|lt|gt|quot|#39|#96);/g;

const ENTITY_TEXT: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  '#96': '`',
};

/** A valid `Max-Age` value. `Number('')` is `0`, so the format is checked before converting. */
const MAX_AGE_VALUE = /^-?\d+$/;

/**
 * A cookie name as RFC 6265 §4.1.1 requires: a token, one or more RFC 9110 `tchar` characters.
 * An allowlist, so separators, spaces, controls and non-ASCII characters are all refused.
 */
const COOKIE_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Characters that would corrupt the `Cookie` request header if stored in a value. */
const INVALID_COOKIE_VALUE = /[;\r\n]/;

/** The only URL schemes the client sends requests over. */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Statuses whose responses carry no content (RFC 9110 §15.3.5, §15.3.6, §15.4.5). */
const NO_CONTENT_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** The path of the cookies sent with every request: those the application sets and clears. */
const ROOT_PATH = '/';

/** Returns the jar key of a cookie; JSON encoding keeps distinct (name, path) pairs distinct. */
function jarKey(name: string, path: string): string {
  return JSON.stringify([name, path]);
}

/**
 * Returns the default cookie path for a request path (RFC 6265 §5.1.4): `/` when the path is
 * empty, does not start with `/` or holds a single `/`, and otherwise the path up to, but not
 * including, its last `/`.
 */
function defaultPath(requestPath: string): string {
  const lastSlash = requestPath.lastIndexOf('/');
  if (!requestPath.startsWith('/') || lastSlash === 0) {
    return ROOT_PATH;
  }
  return requestPath.slice(0, lastSlash);
}

/**
 * Whether a cookie scoped to `cookiePath` is sent to `requestPath` (RFC 6265 §5.1.4): the paths
 * are equal, or `cookiePath` is a prefix that ends with `/` or is followed by `/`, so `/tasks`
 * matches `/tasks/1` but not `/tasks1`.
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return (
    requestPath.length === cookiePath.length ||
    cookiePath.endsWith('/') ||
    requestPath.charAt(cookiePath.length) === '/'
  );
}

/**
 * Returns the unescaped value of the last `_csrf` hidden field in `page`, or `null` when there is
 * none. The layout's logout form and the page's own form carry the same token, so the last match
 * serves either form.
 */
function lastCsrfFieldValue(page: string): string | null {
  let token: string | null = null;
  for (const match of page.matchAll(INPUT_TAG)) {
    const tag = match[0];
    if (!CSRF_NAME_ATTR.test(tag)) {
      continue;
    }
    const value = VALUE_ATTR.exec(tag);
    if (value === null) {
      continue;
    }
    const quoted = value[1] ?? value[2] ?? '';
    // A single pass, so an escaped entity such as `&amp;lt;` becomes `&lt;`, never `<`.
    token = quoted.replace(HTML_ENTITY, (entity, ref: string) => ENTITY_TEXT[ref] ?? entity);
  }
  return token;
}

/**
 * A single-user browser stand-in with a cookie jar, bound to one origin, which it enforces.
 *
 * - **One origin, enforced.** Every request URL must resolve to the base URL's origin. One that
 *   resolves elsewhere, an absolute or protocol-relative URL included, is rejected before it is
 *   sent, so the jar, a page's CSRF token and posted fields never reach another server.
 * - **No redirects are followed.** Each response, a 302 or 303 included, is returned as it is, so
 *   callers assert on `status` and `location` and then request the next page themselves.
 * - **CSRF tokens are bound to the session** (plan 0.3.4). The token on a page served before login
 *   carries the anonymous binding, and a redirect after login renders no page. After logging in,
 *   `get` a page before posting an authenticated form, so the client submits that page's token.
 * - **Cookies.** The jar stores each cookie's raw value as sent and, as a browser does (RFC 6265
 *   §5.3), identifies it by name and path. A `Set-Cookie` without a `Path` starting with `/`
 *   takes the default path of the request URL, and replaces or clears only the cookie of that
 *   name and path, so a clearing `Set-Cookie` must repeat the path the cookie was set with. A
 *   request carries only the cookies whose path matches its own, longest path first (§5.4).
 *   `Secure` and `Domain` are ignored: the client talks to one origin, host-only, over plain
 *   HTTP, and the performance seed must keep the `Secure` cookies a production-mode server sets.
 *   A cookie is removed only by a `Set-Cookie` that expires it, through `Max-Age` when it has one
 *   and through `Expires` otherwise, judged against real time, because Express computes `Expires`
 *   from real time while the server judges session expiry with its own (possibly fake) clock and
 *   tests rely on the cookie still being sent.
 *
 * Concurrent requests on one client are safe; each response updates the jar as it arrives.
 */
export class HttpClient {
  private readonly baseUrl: string;

  private readonly origin: string;

  /**
   * Keyed by {@link jarKey}. A Map iterates in insertion order, which is creation order: `set` on
   * an existing key keeps its place, as a replaced cookie keeps its creation time (§5.3 step 11).
   */
  private readonly jar = new Map<string, StoredCookie>();

  private lastHtml: string | null = null;

  /**
   * @param baseUrl - The origin every path is resolved against, for example
   *   `http://127.0.0.1:3100`. It must be an absolute `http:` or `https:` URL.
   * @throws TypeError when `baseUrl` is not an absolute URL.
   * @throws Error when its scheme is not `http:` or `https:`.
   */
  constructor(baseUrl: string) {
    // Parsing rejects a relative or malformed base URL here rather than at the first request.
    const base = new URL(baseUrl);
    if (!HTTP_PROTOCOLS.has(base.protocol)) {
      throw new Error('HttpClient: base URL must use http: or https:');
    }
    this.baseUrl = base.href;
    this.origin = base.origin;
  }

  /**
   * Sends a `GET` request.
   *
   * @param path - Path and query, resolved against the base URL.
   * @param headers - Extra request headers. A `cookie` header here replaces the jar's cookies.
   * @throws Error, as a rejected promise and with nothing sent, when `path` resolves outside the
   *   base URL's origin; TypeError when it does not resolve to a URL.
   */
  get(path: string, headers?: Record<string, string>): Promise<HttpResult> {
    return this.request('GET', path, headers === undefined ? {} : { headers });
  }

  /**
   * Sends a `HEAD` request. The result's `body` is empty, and the remembered page, so
   * {@link HttpClient.csrfToken}, is kept.
   *
   * @param path - Path and query, resolved against the base URL.
   * @throws Error, as a rejected promise and with nothing sent, when `path` resolves outside the
   *   base URL's origin; TypeError when it does not resolve to a URL.
   */
  head(path: string): Promise<HttpResult> {
    return this.request('HEAD', path, {});
  }

  /**
   * Posts `fields` as an `application/x-www-form-urlencoded` form.
   *
   * An array value is sent as one parameter per element, which produces repeated parameters.
   * The CSRF token is added as `_csrf` unless `fields` already has that key, which then wins:
   * `opts.csrf === false` adds none, a string adds that value, and otherwise the token from the
   * last HTML page is added when there is one.
   *
   * @param path - Path, resolved against the base URL.
   * @param fields - Form fields, in insertion order.
   * @param opts - CSRF behaviour.
   * @throws Error, as a rejected promise and with nothing sent, when `path` resolves outside the
   *   base URL's origin; TypeError when it does not resolve to a URL.
   */
  post(
    path: string,
    fields: Record<string, string | string[]>,
    opts: PostOptions = {},
  ): Promise<HttpResult> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value === 'string') {
        params.append(name, value);
      } else {
        for (const item of value) {
          params.append(name, item);
        }
      }
    }
    if (!Object.hasOwn(fields, CSRF_FIELD_NAME) && opts.csrf !== false) {
      const token = typeof opts.csrf === 'string' ? opts.csrf : this.csrfToken();
      if (token !== null) {
        params.append(CSRF_FIELD_NAME, token);
      }
    }
    return this.request('POST', path, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  }

  /**
   * Posts `body` with the given content type, both unchanged and with no CSRF token added. It
   * serves malformed-request cases such as an oversized body or an unsupported charset.
   *
   * @param path - Path, resolved against the base URL.
   * @param body - The exact request body.
   * @param contentType - The exact `Content-Type` header value.
   * @throws Error, as a rejected promise and with nothing sent, when `path` resolves outside the
   *   base URL's origin; TypeError when it does not resolve to a URL.
   */
  postRaw(path: string, body: string, contentType: string): Promise<HttpResult> {
    return this.request('POST', path, { headers: { 'content-type': contentType }, body });
  }

  /**
   * Returns the raw (still URL-encoded) value of the cookie `name` stored at `Path=/`, the one
   * sent with every request, or `undefined`, not `null`, when the jar holds no such cookie,
   * including after the server cleared it. A cookie of that name scoped to a narrower path is
   * not returned; it is sent only with requests whose path matches its own.
   *
   * @param name - Cookie name, for example `'sid'`.
   */
  cookie(name: string): string | undefined {
    return this.jar.get(jarKey(name, ROOT_PATH))?.value;
  }

  /**
   * Stores a cookie value verbatim at `Path=/`, replacing the one of that name stored there and
   * leaving any scoped to a narrower path. Pass the value already encoded as the server would
   * send it, for example `encodeURIComponent(signCookieValue(token, secret))`, or a value copied
   * from another client's {@link HttpClient.cookie}.
   *
   * @param name - Cookie name.
   * @param rawValue - The exact value to send.
   * @throws Error when the name is not an RFC 6265 token (one or more of the ASCII letters and
   *   digits and ``!#$%&'*+-.^_`|~``, so never empty), or the value holds `;`, CR or LF, any of
   *   which would corrupt the `Cookie` header instead of setting this cookie.
   */
  setCookie(name: string, rawValue: string): void {
    if (!COOKIE_NAME_TOKEN.test(name)) {
      throw new Error('setCookie: invalid cookie name');
    }
    if (INVALID_COOKIE_VALUE.test(rawValue)) {
      throw new Error('setCookie: cookie value must not contain ";", CR or LF');
    }
    this.jar.set(jarKey(name, ROOT_PATH), { name, value: rawValue, path: ROOT_PATH });
  }

  /** Empties the cookie jar. The remembered page, and so its CSRF token, is kept. */
  clearCookies(): void {
    this.jar.clear();
  }

  /**
   * Returns the `_csrf` hidden-field value of the last HTML page received, HTML-unescaped, or
   * `null` when no HTML page has been received or it has no such field. When the page holds
   * several, the last one is returned. A response to `HEAD`, or with status 204, 205 or 304,
   * carries no page and leaves the remembered one in place.
   */
  csrfToken(): string | null {
    return this.lastHtml === null ? null : lastCsrfFieldValue(this.lastHtml);
  }

  private async request(method: string, path: string, init: RequestParts): Promise<HttpResult> {
    const url = new URL(path, this.baseUrl);
    // Checked before any cookie or form field is attached. The scheme is checked as well, because
    // a `blob:` URL reports the origin of the URL it wraps.
    if (!HTTP_PROTOCOLS.has(url.protocol) || url.origin !== this.origin) {
      throw new Error('HttpClient: request URL is outside the client origin');
    }
    const headers: Record<string, string> = { ...init.headers };
    const callerSentCookie = Object.keys(headers).some((key) => key.toLowerCase() === 'cookie');
    // Longer paths first and, for equal lengths, creation order (§5.4 step 2): the jar iterates
    // in creation order and the sort is stable.
    const matching = Array.from(this.jar.values())
      .filter((cookie) => pathMatches(url.pathname, cookie.path))
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.length > 0 && !callerSentCookie) {
      headers['cookie'] = matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }

    const res = await fetch(url, { method, headers, body: init.body, redirect: 'manual' });
    const bytes = Buffer.from(await res.arrayBuffer());
    const body = bytes.toString('utf8');

    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      this.store(parseSetCookie(line), url);
    }

    // Only an actual HTML page replaces the remembered one. A HEAD response or a 204, 205 or 304
    // can carry `Content-Type: text/html` but never content, and keeps the last page's token.
    const contentType = res.headers.get('content-type');
    const carriesPage =
      method !== 'HEAD' &&
      !NO_CONTENT_STATUSES.has(res.status) &&
      contentType !== null &&
      contentType.toLowerCase().startsWith('text/html');
    if (carriesPage) {
      this.lastHtml = body;
    }

    return {
      status: res.status,
      headers: res.headers,
      body,
      bytes,
      location: res.headers.get('location'),
      setCookies,
    };
  }

  /**
   * Applies one received cookie to the jar entry of its name and effective path: an expiring
   * `Set-Cookie` removes that entry, any other stores it. Entries of other paths are untouched.
   */
  private store(cookie: ParsedSetCookie, requestUrl: URL): void {
    // A missing Path, or one not starting with `/`, means the default path (§5.2.4).
    const path =
      cookie.path !== null && cookie.path.startsWith('/')
        ? cookie.path
        : defaultPath(requestUrl.pathname);
    const key = jarKey(cookie.name, path);
    // Max-Age, when present, decides alone, and Expires counts only without it (§5.3 step 3).
    const expired =
      cookie.maxAge !== null
        ? cookie.maxAge <= 0
        : cookie.expires !== null && cookie.expires.getTime() <= Date.now();
    if (expired) {
      this.jar.delete(key);
    } else {
      this.jar.set(key, { name: cookie.name, value: cookie.value, path });
    }
  }
}

/**
 * Signs `value` exactly as cookie-parser expects a signed cookie: the `s:` prefix, the value, a
 * dot and the HMAC-SHA256 of the value keyed by `secret`, in base64 without `=` padding (the
 * format of cookie-signature's `sign`).
 *
 * The result is **not** URL-encoded. Wrap it in `encodeURIComponent` before
 * {@link HttpClient.setCookie}, which matches what `res.cookie(..., { signed: true })` sends.
 *
 * @param value - The cookie value to sign, for example a raw session token.
 * @param secret - The signing secret, the application's `SESSION_SECRET`.
 */
export function signCookieValue(value: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
  return `s:${value}.${signature}`;
}

/**
 * Extracts the raw session token from a signed `sid` cookie value as stored in the jar: it
 * URL-decodes the value, removes the `s:` prefix and cuts the final `.signature`. A base64url
 * token contains no `.`, so the last dot always starts the signature.
 *
 * @param cookieValue - The cookie value, URL-encoded or already decoded.
 * @throws Error when the value is not a signed cookie value.
 */
export function rawSessionToken(cookieValue: string): string {
  const decoded = decodeURIComponent(cookieValue);
  const signed = decoded.startsWith('s:') ? decoded.slice(2) : null;
  const dot = signed === null ? -1 : signed.lastIndexOf('.');
  if (signed === null || dot <= 0) {
    throw new Error('rawSessionToken: not a signed cookie value');
  }
  return signed.slice(0, dot);
}

/**
 * Parses one `Set-Cookie` header line.
 *
 * The first `;`-separated part is `name=value`, split at the first `=`. Attribute names are
 * matched case-insensitively: `HttpOnly`, `Secure`, `SameSite`, `Path`, `Max-Age` and `Expires`
 * are read, and `Domain` and unknown attributes are ignored. The value is kept as sent, not
 * URL-decoded.
 *
 * @param header - One header line, without the `Set-Cookie:` prefix.
 * @throws Error when the line has no `name=value` pair or the name is empty.
 */
export function parseSetCookie(header: string): ParsedSetCookie {
  const [pair = '', ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 0) {
    throw new Error('parseSetCookie: missing name=value pair');
  }
  const name = pair.slice(0, eq).trim();
  if (name === '') {
    throw new Error('parseSetCookie: empty cookie name');
  }

  const cookie: ParsedSetCookie = {
    name,
    value: pair.slice(eq + 1).trim(),
    httpOnly: false,
    secure: false,
    sameSite: null,
    path: null,
    maxAge: null,
    expires: null,
  };
  for (const attribute of attributes) {
    const sep = attribute.indexOf('=');
    const key = (sep < 0 ? attribute : attribute.slice(0, sep)).trim().toLowerCase();
    const value = sep < 0 ? '' : attribute.slice(sep + 1).trim();
    switch (key) {
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = value;
        break;
      case 'path':
        cookie.path = value;
        break;
      // An invalid Max-Age or Expires is ignored, so an earlier valid one stands (§5.2.1-2).
      case 'max-age':
        if (MAX_AGE_VALUE.test(value)) {
          cookie.maxAge = Number(value);
        }
        break;
      case 'expires': {
        const at = new Date(value);
        if (!Number.isNaN(at.getTime())) {
          cookie.expires = at;
        }
        break;
      }
      default:
        break;
    }
  }
  return cookie;
}

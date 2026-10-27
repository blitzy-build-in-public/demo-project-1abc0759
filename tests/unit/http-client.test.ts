/**
 * Unit tests for the cookie-jar client in `tests/helpers/http-client.ts`, the browser oracle the
 * integration suites and the performance seed rely on.
 *
 * Every case drives the client against a local `node:http` server that writes raw `Set-Cookie`
 * lines and echoes the `Cookie` header it receives, so the jar is judged by what goes over the
 * wire: path scoping, replacement and clearing (RFC 6265 §5.1.4, §5.3, §5.4), `Max-Age` taking
 * precedence over `Expires`, the one-origin binding, the remembered CSRF page and the cookie-name
 * token rule. A second server stands for a foreign origin and records every request it receives,
 * which must stay none.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { HttpClient, parseSetCookie, signCookieValue } from '../helpers/http-client';
import type { HttpResult } from '../helpers/http-client';

/** The echo body for a request that carried no `Cookie` header. */
const NO_COOKIE = '<none>';

/** The `Expires` value Express 4's `res.clearCookie` writes. */
const EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** An `Expires` value far in the future. */
const FUTURE = 'Wed, 01 Jan 2099 00:00:00 GMT';

/** The CSRF token of `/page`, which serves it HTML-escaped. */
const PAGE_TOKEN = 'tok&1';

/** The CSRF token of `/next-page`. */
const NEXT_TOKEN = 'next-token';

/** Returns a form page whose `_csrf` field holds `escapedToken` as written. */
function formPage(escapedToken: string): string {
  return `<form method="post"><input type="hidden" name="_csrf" value="${escapedToken}"></form>`;
}

/** The HTML pages the application stand-in serves, by path. */
const PAGES: Readonly<Record<string, string>> = {
  '/page': formPage('tok&amp;1'),
  '/next-page': formPage(NEXT_TOKEN),
};

/** The exact message of a request refused for leaving the client's origin. */
const OUTSIDE_ORIGIN = /^HttpClient: request URL is outside the client origin$/;

/** One request the foreign server received. */
interface ForeignHit {
  url: string;
  cookie: string | null;
}

/** Every request the foreign server has received. */
const foreignHits: ForeignHit[] = [];

let app: Server;
let foreign: Server;
let base = '';
let foreignBase = '';

/** Reads a request body as UTF-8. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The application stand-in. Each `set` query parameter becomes one raw `Set-Cookie` line, so a
 * case sets cookies from whichever request path it needs. Then:
 * - a path in {@link PAGES} answers with that HTML page;
 * - `/status/<code>` answers with that status, `Content-Type: text/html` and no content;
 * - any other `POST` answers with the received form body;
 * - anything else answers with the received `Cookie` header, or {@link NO_COOKIE}.
 */
async function handleApp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const lines = url.searchParams.getAll('set');
  if (lines.length > 0) {
    res.setHeader('set-cookie', lines);
  }
  const body = await readBody(req);
  const page = PAGES[url.pathname];
  const status = /^\/status\/(\d{3})$/.exec(url.pathname);
  if (page !== undefined) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  } else if (status !== null) {
    res.writeHead(Number(status[1]), { 'content-type': 'text/html; charset=utf-8' });
    res.end();
  } else if (req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  } else {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.headers.cookie ?? NO_COOKIE);
  }
}

/** Starts `server` on an ephemeral loopback port and returns its origin. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server has no TCP address'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** Stops `server`, dropping the keep-alive connections `fetch` leaves open. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Returns `path` with one `set` query parameter per raw `Set-Cookie` line. */
function setting(path: string, ...lines: string[]): string {
  const query = new URLSearchParams(lines.map((line): [string, string] => ['set', line]));
  return `${path}?${query.toString()}`;
}

/** Returns the `Cookie` header `client` sends to `path`, or {@link NO_COOKIE}. */
async function sentCookies(client: HttpClient, path: string): Promise<string> {
  return (await client.get(path)).body;
}

/** Returns a client holding `sid=A` at `/` and then `sid=B` at `/tasks`. */
async function twoSids(): Promise<HttpClient> {
  const client = new HttpClient(base);
  await client.get(setting('/', 'sid=A; Path=/; HttpOnly'));
  await client.get(setting('/', 'sid=B; Path=/tasks; HttpOnly'));
  return client;
}

beforeAll(async () => {
  app = createServer((req, res) => {
    // A failure drops the connection, so the request under test rejects instead of hanging.
    handleApp(req, res).catch(() => res.destroy());
  });
  foreign = createServer((req, res) => {
    foreignHits.push({ url: req.url ?? '', cookie: req.headers.cookie ?? null });
    req.resume();
    req.on('end', () => res.end('collected'));
  });
  [base, foreignBase] = await Promise.all([listen(app), listen(foreign)]);
});

afterAll(async () => {
  await Promise.all([close(app), close(foreign)]);
});

describe('HttpClient cookie paths (RFC 6265 §5.1.4, §5.3, §5.4)', () => {
  it.each([
    ['/x', 'sid=A'],
    ['/tasks', 'sid=B; sid=A'],
    ['/tasks/x', 'sid=B; sid=A'],
    ['/tasksx', 'sid=A'],
  ])('keeps sid at / and at /tasks apart: %s is sent %p', async (path, expected) => {
    const client = await twoSids();

    expect(await sentCookies(client, path)).toBe(expected);
    expect(client.cookie('sid')).toBe('A');
  });

  it('clearing sid at Path=/tasks keeps the sid at /', async () => {
    const client = await twoSids();
    await client.get(setting('/tasks/x', `sid=; Path=/tasks; Expires=${EPOCH}; HttpOnly`));

    expect(client.cookie('sid')).toBe('A');
    expect(await sentCookies(client, '/tasks/x')).toBe('sid=A');
  });

  it('clearing sid at Path=/ as res.clearCookie writes it removes only the sid at /', async () => {
    const client = await twoSids();
    await client.get(setting('/logout', `sid=; Path=/; Expires=${EPOCH}; HttpOnly; SameSite=Lax`));

    expect(client.cookie('sid')).toBeUndefined();
    expect(await sentCookies(client, '/x')).toBe(NO_COOKIE);
    expect(await sentCookies(client, '/tasks/x')).toBe('sid=B');
  });

  it.each(['np=1', 'np=1; Path=', 'np=1; Path=a/b'])(
    'stores %p, received from /a/b/set, at the default path /a/b',
    async (line) => {
      const client = new HttpClient(base);
      await client.get(setting('/a/b/set', line));

      expect(await sentCookies(client, '/a/b/x')).toBe('np=1');
      expect(await sentCookies(client, '/a/b')).toBe('np=1');
      expect(await sentCookies(client, '/a/bc')).toBe(NO_COOKIE);
      expect(await sentCookies(client, '/a/x')).toBe(NO_COOKIE);
      expect(await sentCookies(client, '/')).toBe(NO_COOKIE);
      expect(client.cookie('np')).toBeUndefined();
    },
  );

  it('stores a cookie without Path received from a one-segment path at /', async () => {
    const client = new HttpClient(base);
    await client.get(setting('/login', 'np=1'));

    expect(client.cookie('np')).toBe('1');
    expect(await sentCookies(client, '/tasks/x')).toBe('np=1');
  });

  it('stores and sends a Secure cookie over plain HTTP', async () => {
    const client = new HttpClient(base);
    await client.get(setting('/', 'sec=S; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax'));

    expect(client.cookie('sec')).toBe('S');
    expect(await sentCookies(client, '/x')).toBe('sec=S');
  });

  it('setCookie replaces the cookie at / and leaves the one at /tasks', async () => {
    const client = await twoSids();
    client.setCookie('sid', 'T');

    expect(client.cookie('sid')).toBe('T');
    expect(await sentCookies(client, '/x')).toBe('sid=T');
    expect(await sentCookies(client, '/tasks/x')).toBe('sid=B; sid=T');
  });

  it('orders equal paths by creation: replaced cookies stay, re-added ones go last', async () => {
    const client = new HttpClient(base);
    await client.get(setting('/', 'a=1; Path=/', 'b=1; Path=/'));
    await client.get(setting('/', 'a=2; Path=/'));

    expect(await sentCookies(client, '/x')).toBe('a=2; b=1');

    await client.get(setting('/', `a=; Path=/; Expires=${EPOCH}`));
    await client.get(setting('/', 'a=3; Path=/'));

    expect(await sentCookies(client, '/x')).toBe('b=1; a=3');
  });

  it.each(['cookie', 'Cookie', 'COOKIE'])('a caller %p header replaces the jar', async (name) => {
    const client = await twoSids();

    expect((await client.get('/tasks/x', { [name]: 'x=1' })).body).toBe('x=1');
  });

  it('clearCookies empties every path', async () => {
    const client = await twoSids();
    client.clearCookies();

    expect(await sentCookies(client, '/tasks/x')).toBe(NO_COOKIE);
  });
});

describe('HttpClient origin binding', () => {
  /** Sends one request that leaves the client's origin. */
  type Send = (client: HttpClient) => Promise<HttpResult>;

  it.each<[string, Send]>([
    ['get with an absolute foreign URL', (c) => c.get(`${foreignBase}/collect`)],
    [
      'get with a protocol-relative foreign URL',
      (c) => c.get(`${foreignBase.replace(/^http:/, '')}/collect`),
    ],
    [
      'post with credentials to a foreign URL',
      (c) => c.post(`${foreignBase}/collect`, { email: 'u@example.test', password: 'Secret12345' }),
    ],
    ['head to a foreign URL', (c) => c.head(`${foreignBase}/collect`)],
    ['postRaw to a foreign URL', (c) => c.postRaw(`${foreignBase}/collect`, 'a=b', 'text/plain')],
    ['get with a data: URL', (c) => c.get('data:text/plain,hi')],
    ['get with a blob: URL wrapping its own origin', (c) => c.get(`blob:${base}/x`)],
  ])('rejects %s before sending anything', async (_label, send) => {
    const client = new HttpClient(base);
    await client.get(setting('/page', 'sid=A; Path=/'));

    await expect(send(client)).rejects.toThrow(OUTSIDE_ORIGIN);
    expect(foreignHits).toEqual([]);
  });

  it('allows an absolute URL on its own origin and sends the jar with it', async () => {
    const client = new HttpClient(base);
    await client.get(setting('/', 'sid=A; Path=/'));

    expect(await sentCookies(client, `${base}/x`)).toBe('sid=A');
  });

  it.each(['file:///tmp/', 'data:text/plain,hi', 'ftp://127.0.0.1/'])(
    'refuses the non-HTTP base URL %p',
    (url) => {
      expect(() => new HttpClient(url)).toThrow(/^HttpClient: base URL must use http: or https:$/);
    },
  );

  it('refuses a relative base URL', () => {
    // Node's URL throws its own realm's TypeError, which is not Jest's global, so match the text.
    expect(() => new HttpClient('/tasks')).toThrow(/^Invalid URL$/);
  });
});

describe('HttpClient remembered CSRF page', () => {
  /** Receives one response that carries `Content-Type: text/html` but no content. */
  type Receive = (client: HttpClient) => Promise<HttpResult>;

  it.each<[string, Receive]>([
    ['a HEAD response', (c) => c.head('/page')],
    ['a 204 response', (c) => c.get('/status/204')],
    ['a 205 response', (c) => c.get('/status/205')],
    ['a 304 response', (c) => c.get('/status/304')],
  ])('keeps the last page and its token across %s', async (_label, receive) => {
    const client = new HttpClient(base);
    await client.get('/page');
    const empty = await receive(client);

    expect(empty.headers.get('content-type')).toMatch(/^text\/html/);
    expect(empty.body).toBe('');
    expect(client.csrfToken()).toBe(PAGE_TOKEN);
    const posted = new URLSearchParams((await client.post('/form', { a: '1' })).body);
    expect(posted.get('_csrf')).toBe(PAGE_TOKEN);
  });

  it('replaces the remembered page with the next HTML page only', async () => {
    const client = new HttpClient(base);
    await client.get('/page');
    await client.get('/x');

    expect(client.csrfToken()).toBe(PAGE_TOKEN);

    await client.get('/next-page');

    expect(client.csrfToken()).toBe(NEXT_TOKEN);
  });
});

describe('HttpClient Max-Age and Expires (RFC 6265 §5.2.1, §5.2.2, §5.3 step 3)', () => {
  it.each<[string, string, string | undefined]>([
    ['Max-Age=28800 with an epoch Expires keeps it', `sid=A; Max-Age=28800; Expires=${EPOCH}`, 'A'],
    ['Max-Age=0 with a future Expires removes it', `sid=; Max-Age=0; Expires=${FUTURE}`, undefined],
    ['a negative Max-Age removes it', 'sid=; Max-Age=-1', undefined],
    ['an epoch Expires alone removes it', `sid=; Expires=${EPOCH}`, undefined],
    [
      'an invalid Max-Age after a valid one leaves the valid one deciding',
      `sid=A; Max-Age=28800; Max-Age=x; Expires=${EPOCH}`,
      'A',
    ],
    [
      'an invalid Expires after an epoch one leaves the epoch deciding',
      `sid=A; Expires=${EPOCH}; Expires=never`,
      undefined,
    ],
  ])('%s', async (_label, line, expected) => {
    const client = new HttpClient(base);
    client.setCookie('sid', 'OLD');
    await client.get(setting('/', `${line}; Path=/`));

    expect(client.cookie('sid')).toBe(expected);
    expect(await sentCookies(client, '/x')).toBe(
      expected === undefined ? NO_COOKIE : `sid=${expected}`,
    );
  });

  it.each<[string, number | null, number | null]>([
    ['sid=A; Max-Age=28800; Max-Age=x', 28800, null],
    ['sid=A; Max-Age=10; Max-Age=20', 20, null],
    ['sid=A; Max-Age=', null, null],
    [`sid=A; Expires=${EPOCH}; Expires=never`, null, 0],
  ])('parseSetCookie(%p) keeps the last valid Max-Age and Expires', (line, maxAge, expiresAt) => {
    const parsed = parseSetCookie(line);

    expect(parsed.maxAge).toBe(maxAge);
    expect(parsed.expires?.getTime() ?? null).toBe(expiresAt);
  });
});

describe('HttpClient.setCookie names (RFC 6265 §4.1.1)', () => {
  it.each([
    'bad/name',
    'a:b',
    '(x)',
    '[x]',
    '{x}',
    '"q"',
    'back\\slash',
    'caf\u00e9',
    'a?b',
    'a@b',
    '<x>',
    'a b',
    '',
    'a=b',
    'a;b',
    'a,b',
    '\u0001',
    'sid\n',
  ])('rejects the non-token name %p', (name) => {
    const client = new HttpClient(base);

    expect(() => client.setCookie(name, 'x')).toThrow(/^setCookie: invalid cookie name$/);
    expect(client.cookie(name)).toBeUndefined();
  });

  it.each(['sid', 'csrf', "a!#$%&'*+-.^_`|~09AZaz"])(
    'accepts the token %p and sends it',
    async (name) => {
      const client = new HttpClient(base);
      client.setCookie(name, 'x');

      expect(client.cookie(name)).toBe('x');
      expect(await sentCookies(client, '/x')).toBe(`${name}=x`);
    },
  );

  it('sends an already URL-encoded value verbatim', async () => {
    const client = new HttpClient(base);
    const value = encodeURIComponent(signCookieValue('token', 'x'.repeat(32)));
    client.setCookie('sid', value);

    expect(client.cookie('sid')).toBe(value);
    expect(await sentCookies(client, '/x')).toBe(`sid=${value}`);
  });
});

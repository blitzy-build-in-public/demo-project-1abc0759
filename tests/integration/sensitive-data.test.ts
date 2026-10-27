/**
 * Integration test: no password, password hash or session token reaches the server log, a page,
 * a redirect or the CSV export (plan 0.1.1, 0.3.4).
 *
 * One flow drives the real stack over HTTP: sign-up and login, the re-rendered forms that receive
 * the password, every task page, the reports page, the export, two 503 responses from an instance
 * whose database is unreachable (one request carrying the password, one the session cookie), and
 * logout. Both instances write into one `CaptureLogger`, so the scan reads the production log
 * serialisation of real failures. Every response is collected and each secret is searched for as
 * a raw string: the password is alphanumeric and the token base64url, so HTML escaping, URL
 * encoding and JSON escaping leave them unchanged and one raw search covers every serialised form.
 *
 * A leak is reported by the secret's name and the place it was found, never by its value.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { CSV_HEADER } from '../../src/reports/csv';

import { CaptureLogger } from '../helpers/capture-logger';
import { parseCsv } from '../helpers/csv-parse';
import { FAKE_CLOCK_START, FakeClock } from '../helpers/fake-clock';
import { rawSessionToken } from '../helpers/http-client';
import type { HttpResult } from '../helpers/http-client';
import { startTestApp } from '../helpers/test-app';
import type { TestApp } from '../helpers/test-app';
import { createTestPool, sql, truncateAll, userIdByEmail } from '../helpers/test-db';

/** A connection string that refuses every connection; its name still passes the `_test` guard. */
const UNREACHABLE_DATABASE_URL = 'postgres://tasktracker:x@127.0.0.1:1/unreachable_test';

/** Name of the signed session cookie, the session token's only permitted channel. */
const SESSION_COOKIE = 'sid';

/** Inclusive export range ending on the fake clock's start date, all statuses. */
const EXPORT_PATH = '/reports/export?from=2026-10-01&to=2026-10-21&status=';

/** The export's eight columns. */
const EXPORT_COLUMN_COUNT = 8;

/** An email the sign-up policy rejects, so the form is re-rendered with the password submitted. */
const INVALID_EMAIL = 'not-an-email';

/** A bcrypt hash at cost 12: the `$2b$12$` prefix and 53 characters of the bcrypt alphabet. */
const BCRYPT_COST_12_HASH = /^\$2b\$12\$[./A-Za-z0-9]{53}$/;

/** A session token: 32 random bytes as unpadded base64url. */
const SESSION_TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Fields of the task form, as `POST /tasks/new` receives them. */
type TaskForm = {
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string;
};

/** The two tasks the flow creates; the first needs RFC 4180 quoting in every text field. */
const TASK_FORMS: readonly TaskForm[] = [
  {
    title: 'Budget, "Q4" review',
    description: 'First line\r\nSecond, "quoted" line',
    status: 'To do',
    priority: 'High',
    dueDate: '2026-10-25',
  },
  {
    title: 'Write release notes',
    description: '',
    status: 'Done',
    priority: 'Low',
    dueDate: '',
  },
];

/** Names of the secrets that a `sid` Set-Cookie line legitimately carries. */
const TOKEN_SECRET_NAMES: readonly string[] = ['session token', 'URL-encoded session token'];

/** One collected response and the request that produced it, for leak reports. */
interface Seen {
  label: string;
  result: HttpResult;
}

/** A value that must never appear outside its permitted channel. */
interface Secret {
  name: string;
  value: string;
}

/** One piece of output that is searched, and the names of the secrets it may carry. */
interface Surface {
  where: string;
  text: string;
  allowed?: readonly string[];
}

/** A row holding a user's stored password hash. */
interface PasswordHashRow {
  passwordHash: string;
}

/** A row holding a session's `id` (the SHA-256 of its token) as lowercase hex. */
interface SessionHexRow {
  hex: string;
}

/** A row holding a task id. */
interface TaskIdRow {
  id: number;
}

/** Returns `value`, throwing when it is missing, so later steps work on a narrowed type. */
function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}`);
  }
  return value;
}

/** Every response header except `Set-Cookie`, `Location` included, one `name: value` per line. */
function headerText(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      lines.push(`${name}: ${value}`);
    }
  });
  return lines.join('\n');
}

/**
 * The searchable parts of every collected response: the body, the other headers, and each
 * `Set-Cookie` line, of which only a `sid` line may carry the session token.
 */
function responseSurfaces(seen: readonly Seen[]): Surface[] {
  return seen.flatMap(({ label, result }): Surface[] => [
    { where: `body of ${label}`, text: result.body },
    { where: `headers of ${label}`, text: headerText(result.headers) },
    ...result.setCookies.map(
      (line, index): Surface => ({
        where: `Set-Cookie ${index + 1} of ${label}`,
        text: line,
        allowed: line.startsWith(`${SESSION_COOKIE}=`) ? TOKEN_SECRET_NAMES : [],
      }),
    ),
  ]);
}

/** Returns `"<secret> in <where>"` for every secret found on a surface that does not allow it. */
function findLeaks(secrets: readonly Secret[], surfaces: readonly Surface[]): string[] {
  const leaks: string[] = [];
  for (const surface of surfaces) {
    for (const secret of secrets) {
      const allowed = surface.allowed?.includes(secret.name) ?? false;
      if (!allowed && surface.text.includes(secret.value)) {
        leaks.push(`${secret.name} in ${surface.where}`);
      }
    }
  }
  return leaks;
}

describe('sensitive data', () => {
  const clock = new FakeClock();
  const log = new CaptureLogger();
  // Shared by both instances, so the session cookie issued by `app` verifies on `down` and its
  // request reaches the session lookup, which then fails against the unreachable database.
  const sessionSecret = randomBytes(32).toString('hex');
  let pool: Pool;
  let app: TestApp;
  let down: TestApp;

  beforeAll(async () => {
    pool = createTestPool();
    app = await startTestApp({ clock, logger: log, sessionSecret });
    down = await startTestApp({
      clock,
      logger: log,
      sessionSecret,
      databaseUrl: UNREACHABLE_DATABASE_URL,
    });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    clock.set(FAKE_CLOCK_START);
    log.clear();
  });

  afterAll(async () => {
    await Promise.all([app.close(), down.close()]);
    await pool.end();
  });

  it('keeps passwords, hashes and session tokens out of logs, pages, redirects and CSV', async () => {
    const seen: Seen[] = [];
    const track = (label: string, result: HttpResult): HttpResult => {
      seen.push({ label, result });
      return result;
    };
    const password = `Sekrit${randomBytes(16).toString('hex')}7`;
    const email = `Sensitive.${randomBytes(4).toString('hex')}@Example.com`;
    const user = app.client();

    // 1. Sign up and log in.
    expect(track('GET /signup', await user.get('/signup')).status).toBe(200);
    const signUp = track('POST /signup', await user.post('/signup', { email, password }));
    expect(signUp.status).toBe(303);
    expect(signUp.location).toBe('/login?created=1');
    expect(track('GET /login?created=1', await user.get('/login?created=1')).status).toBe(200);
    const logIn = track('POST /login', await user.post('/login', { email, password }));
    expect(logIn.status).toBe(303);
    expect(logIn.location).toBe('/tasks');
    const sid = defined(user.cookie(SESSION_COOKIE), 'a session cookie after login');
    const token = rawSessionToken(sid);

    // The database truth for the hash and the session id is read while the session exists.
    const userId = defined(await userIdByEmail(pool, email), 'the new user');
    const hashRows = await sql<PasswordHashRow>(
      pool,
      'SELECT password_hash AS "passwordHash" FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const hash = defined(hashRows[0], 'a password hash').passwordHash;
    const sessionRows = await sql<SessionHexRow>(
      pool,
      "SELECT encode(id, 'hex') AS hex FROM sessions WHERE user_id = $1",
      [userId],
    );
    expect(sessionRows).toHaveLength(1);
    const sessionIdHex = defined(sessionRows[0], 'a session row').hex;
    expect(hash).toMatch(BCRYPT_COST_12_HASH);
    expect(token).toMatch(SESSION_TOKEN_FORMAT);
    expect(sessionIdHex).toBe(createHash('sha256').update(token).digest('hex'));

    // 2. Re-rendered forms that received the password. Signed-in requests to these routes are
    // redirected away, so a separate anonymous client submits them.
    const anon = app.client();
    expect(track('GET /signup (anonymous)', await anon.get('/signup')).status).toBe(200);
    const badSignUp = track(
      'POST /signup with an invalid email',
      await anon.post('/signup', { email: INVALID_EMAIL, password }),
    );
    expect(badSignUp.status).toBe(422);
    expect(track('GET /login (anonymous)', await anon.get('/login')).status).toBe(200);
    const badLogIn = track(
      'POST /login with a wrong password',
      await anon.post('/login', { email, password: `${password}x` }),
    );
    expect(badLogIn.status).toBe(422);

    // 3. Every task page and the reports page. The list is fetched first because the login
    // redirect carries no page, and only a page supplies the session-bound CSRF token.
    expect(track('GET /tasks (empty)', await user.get('/tasks')).status).toBe(200);
    for (const [index, form] of TASK_FORMS.entries()) {
      const label = `POST /tasks/new (task ${index + 1})`;
      const created = track(label, await user.post('/tasks/new', form));
      expect(created.status).toBe(303);
    }
    const taskRows = await sql<TaskIdRow>(
      pool,
      'SELECT id FROM tasks WHERE owner_id = $1 ORDER BY id',
      [userId],
    );
    expect(taskRows).toHaveLength(TASK_FORMS.length);
    const firstTaskId = defined(taskRows[0], 'a task row').id;
    const list = track('GET /tasks', await user.get('/tasks'));
    expect(list.status).toBe(200);
    expect(list.body).toContain('Write release notes');
    expect(track('GET /tasks/new', await user.get('/tasks/new')).status).toBe(200);
    const editPath = `/tasks/${firstTaskId}/edit`;
    expect(track(`GET ${editPath}`, await user.get(editPath)).status).toBe(200);
    const deletePath = `/tasks/${firstTaskId}/delete`;
    const confirmPage = track(`POST ${deletePath} (unconfirmed)`, await user.post(deletePath, {}));
    expect(confirmPage.status).toBe(200);
    expect(confirmPage.body).toContain('Delete this task?');
    expect(track('GET /reports', await user.get('/reports')).status).toBe(200);

    // 4. The export.
    const exported = track('GET /reports/export', await user.get(EXPORT_PATH));
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('text/csv; charset=utf-8; header=present');
    const csvText = exported.bytes.toString('utf8');

    // 5. Failures logged with the password in the request body and the session in its cookie.
    const downAnon = down.client();
    expect(track('GET /login (database down)', await downAnon.get('/login')).status).toBe(200);
    const downLogIn = track(
      'POST /login (database down)',
      await downAnon.post('/login', { email, password }),
    );
    expect(downLogIn.status).toBe(503);
    expect(downLogIn.body).toContain('Service temporarily unavailable');
    const downUser = down.client();
    downUser.setCookie(SESSION_COOKIE, sid);
    const downTasks = track('GET /tasks (database down)', await downUser.get('/tasks'));
    expect(downTasks.status).toBe(503);
    expect(downTasks.body).toContain('Service temporarily unavailable');

    // 6. Logout. The last page the client received, the reports page, holds the session token.
    const logOut = track('POST /logout', await user.post('/logout', {}));
    expect(logOut.status).toBe(303);
    expect(logOut.location).toBe('/login');
    expect(user.cookie(SESSION_COOKIE)).toBeUndefined();
    const afterLogOut = track('GET /tasks after logout', await user.get('/tasks'));
    expect(afterLogOut.status).toBe(302);
    expect(afterLogOut.location).toBe('/login?next=%2Ftasks');

    // The scan must read real failure logs: one entry per 503, each naming only method and path.
    const logText = log.text();
    expect(logText).not.toBe('');
    expect(logText).toContain('database unavailable');
    const unavailable = log
      .byMsg('database unavailable')
      .map((entry) => `${String(entry.method)} ${String(entry.path)}`);
    expect(unavailable).toEqual(['POST /login', 'GET /tasks']);

    // The token's one permitted channel did carry it, so the allowance hides nothing else.
    const carriesToken = (line: string): boolean =>
      line.startsWith(`${SESSION_COOKIE}=`) && line.includes(token);
    expect(logIn.setCookies.some(carriesToken)).toBe(true);

    const secrets: readonly Secret[] = [
      { name: 'password', value: password },
      { name: 'password hash', value: hash },
      { name: 'session token', value: token },
      { name: 'URL-encoded session token', value: encodeURIComponent(token) },
      { name: 'session id hash', value: sessionIdHex },
    ];
    const surfaces: readonly Surface[] = [
      { where: 'the captured log', text: logText },
      ...responseSurfaces(seen),
      { where: 'the CSV export', text: csvText },
    ];
    expect(findLeaks(secrets, surfaces)).toEqual([]);

    // The export holds the eight task columns and nothing about the user.
    expect(csvText.toLowerCase()).not.toContain(email.toLowerCase());
    const csv = parseCsv(exported.bytes);
    expect(csv.bom).toBe(true);
    expect(CSV_HEADER).toHaveLength(EXPORT_COLUMN_COUNT);
    expect(csv.records[0]).toEqual([...CSV_HEADER]);
    const dataRecords = csv.records.slice(1);
    expect(dataRecords).toHaveLength(TASK_FORMS.length);
    for (const record of dataRecords) {
      expect(record).toHaveLength(EXPORT_COLUMN_COUNT);
    }
    expect(dataRecords.map((record) => record.slice(0, 3))).toEqual(
      TASK_FORMS.map((form, index) => [String(taskRows[index]?.id), form.title, form.description]),
    );

    // Each re-render kept the entered email, so it really rendered the submission, but never
    // echoed the password.
    expect(badSignUp.body).toContain(`value="${INVALID_EMAIL}"`);
    expect(badSignUp.body).not.toContain(password);
    expect(badLogIn.body).toContain(`value="${email}"`);
    expect(badLogIn.body).not.toContain(password);
  });
});

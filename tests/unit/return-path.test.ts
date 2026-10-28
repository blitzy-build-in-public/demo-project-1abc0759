/**
 * Unit tests of the login return path (pure functions, no I/O).
 *
 * `next` arrives in a query string or a form field, so it is attacker-controlled. A value is kept
 * only when it begins with a single `/`, contains no backslash or control character, is at most
 * 2,048 characters, stays on the same origin, and does not target `/login`, `/signup` or
 * `/logout`. Anything else becomes `/tasks`, so the parameter can never become an open redirect.
 * `loginRedirectFor` carries the original path and query for `GET` and `HEAD` only: a
 * state-changing request is never replayed after login.
 *
 * The request field reader and the list-filter parser in `src/web/validation/params.ts` are
 * covered here too. An empty or absent filter value means no filter, and an unknown value or a
 * repeated parameter is malformed (400). The status-change and delete routes validate the posted
 * filter echoes by passing `{ status: body.filterStatus, priority: body.filterPriority }`, so an
 * echo that was not posted reaches the parser as an own key holding `undefined`. That key is
 * absent: it sets no filter instead of throwing, while every other non-string value is still
 * malformed.
 */

import type { Request } from 'express';

import { BadRequestError } from '../../src/shared/errors';
import type { TaskFilters } from '../../src/tasks/types';
import {
  DEFAULT_RETURN_PATH,
  MAX_RETURN_PATH_LENGTH,
  loginRedirectFor,
  sanitizeReturnPath,
} from '../../src/web/return-path';
import { parseListFilters, readField } from '../../src/web/validation/params';

/**
 * Builds the request stand-in `loginRedirectFor` receives. `url` and `path` are filled in beside
 * `originalUrl` so the tests hold whichever property the implementation reads.
 */
function fakeRequest(method: string, originalUrl: string): Request {
  return {
    method,
    originalUrl,
    url: originalUrl,
    path: originalUrl.split('?')[0] ?? originalUrl,
  } as unknown as Request;
}

/** A path of exactly 2,048 characters: the longest value accepted. */
const LONGEST_PATH = '/' + 'a'.repeat(2047);

/** A path of 2,049 characters: one past the limit. */
const TOO_LONG_PATH = '/' + 'a'.repeat(2048);

/**
 * 701 characters as submitted, but each `é` percent-encodes to `%C3%A9`, so the normalised path
 * that would be redirected to is 4,201 characters long.
 */
const EXPANDS_PAST_LIMIT = '/' + 'é'.repeat(700);

/** A parsed form body: each value is a string, or an array for a repeated key. */
type PostedBody = Readonly<Record<string, string | readonly string[]>>;

/** Builds the object the status-change and delete routes pass to `parseListFilters`. */
function echo(body: PostedBody): { status: unknown; priority: unknown } {
  return { status: body.filterStatus, priority: body.filterPriority };
}

/** Copies `fields` onto a null-prototype object, the shape Express's simple parsers produce. */
function nullPrototype(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, fields);
}

/**
 * Asserts that `run` throws the malformed-request error the error handler renders as 400
 * "Bad request.".
 */
function expectBadRequest(run: () => unknown): void {
  expect(run).toThrow(BadRequestError);
  expect(run).toThrow(expect.objectContaining({ status: 400, publicMessage: 'Bad request.' }));
}

describe('return-path constants', () => {
  test('the default return path is the task list', () => {
    expect(DEFAULT_RETURN_PATH).toBe('/tasks');
  });

  test('the length limit is 2,048 characters', () => {
    expect(MAX_RETURN_PATH_LENGTH).toBe(2048);
  });
});

describe('sanitizeReturnPath', () => {
  test('length fixtures sit exactly at and just past the limit', () => {
    expect(LONGEST_PATH).toHaveLength(2048);
    expect(TOO_LONG_PATH).toHaveLength(2049);
    expect(EXPANDS_PAST_LIMIT).toHaveLength(701);
    expect(encodeURI(EXPANDS_PAST_LIMIT)).toHaveLength(4201);
  });

  test('the backslash fixtures hold one backslash character each', () => {
    expect('/\\evil.example').toHaveLength(14);
    expect('/\\evil.example'.charAt(1)).toBe('\\');
    expect('/tasks\\new').toHaveLength(10);
  });

  test.each<{ name: string; raw: string }>([
    { name: 'the task list', raw: '/tasks' },
    { name: 'the new-task form', raw: '/tasks/new' },
    { name: 'an edit page', raw: '/tasks/12/edit' },
    { name: 'a filtered list with an encoded space', raw: '/tasks?status=To%20do&priority=High' },
    { name: 'the reports page with a range', raw: '/reports?from=2026-09-22&to=2026-10-21' },
    { name: 'the reports page', raw: '/reports' },
    { name: 'a path of exactly 2,048 characters', raw: LONGEST_PATH },
    { name: 'a path that only starts with an auth page name', raw: '/loginx' },
  ])('keeps $name unchanged', ({ raw }) => {
    expect(sanitizeReturnPath(raw)).toBe(raw);
  });

  test.each<{ name: string; raw: string; expected: string }>([
    { name: 'a fragment, which is dropped', raw: '/tasks#top', expected: '/tasks' },
    { name: 'a single-dot segment', raw: '/tasks/./new', expected: '/tasks/new' },
    { name: 'a double-dot segment', raw: '/reports/../tasks', expected: '/tasks' },
  ])('normalises $name', ({ raw, expected }) => {
    expect(sanitizeReturnPath(raw)).toBe(expected);
  });

  test.each<{ name: string; raw: unknown }>([
    { name: 'undefined', raw: undefined },
    { name: 'null', raw: null },
    { name: 'an empty string', raw: '' },
    { name: 'an array from a repeated parameter', raw: ['/tasks/new'] },
    { name: 'a number', raw: 42 },
    { name: 'an object', raw: {} },
    { name: 'a relative path without a leading slash', raw: 'tasks' },
    { name: 'a nested relative path without a leading slash', raw: 'tasks/new' },
    { name: 'a protocol-relative host', raw: '//evil.example' },
    { name: 'a protocol-relative host with a path', raw: '//evil.example/tasks' },
    { name: 'a slash-backslash host', raw: '/\\evil.example' },
    { name: 'an absolute URL', raw: 'https://evil.example' },
    { name: 'a javascript: URL', raw: 'javascript:alert(1)' },
    { name: 'a backslash inside the path', raw: '/tasks\\new' },
    { name: 'a line feed', raw: '/tasks\n' },
    { name: 'a tab', raw: '/ta\tsks' },
    { name: 'a NUL character', raw: '/tasks\u0000' },
    { name: 'a carriage return', raw: '/tasks\r' },
    { name: 'a DEL character', raw: '/tasks\u007f' },
    { name: 'a C1 control character', raw: '/tasks\u0085' },
    { name: 'a path of 2,049 characters', raw: TOO_LONG_PATH },
    { name: 'a path whose encoded form exceeds 2,048 characters', raw: EXPANDS_PAST_LIMIT },
    { name: 'the login page', raw: '/login' },
    { name: 'the login page with its own next parameter', raw: '/login?next=%2Ftasks' },
    { name: 'the sign-up page', raw: '/signup' },
    { name: 'the logout endpoint', raw: '/logout' },
    { name: 'the login page in upper case', raw: '/LOGIN' },
    { name: 'the sign-up page with a trailing slash', raw: '/signup/' },
    { name: 'a dot segment that resolves to the login page', raw: '/tasks/../login' },
    { name: 'a dot segment that collapses to a protocol-relative host', raw: '/.//evil.example' },
    {
      name: 'a double-dot segment that collapses to a protocol-relative host',
      raw: '/tasks/..//evil.example',
    },
  ])('replaces $name with /tasks', ({ raw }) => {
    expect(sanitizeReturnPath(raw)).toBe('/tasks');
  });
});

describe('loginRedirectFor', () => {
  test('a GET carries its encoded path', () => {
    expect(loginRedirectFor(fakeRequest('GET', '/tasks/new'))).toBe('/login?next=%2Ftasks%2Fnew');
  });

  test('a GET carries its encoded path and query', () => {
    const original = '/tasks?status=To%20do&priority=High';
    const location = loginRedirectFor(fakeRequest('GET', original));

    expect(location).toBe('/login?next=' + encodeURIComponent(original));
    expect(location).toBe('/login?next=%2Ftasks%3Fstatus%3DTo%2520do%26priority%3DHigh');
  });

  test('a HEAD carries its encoded path', () => {
    expect(loginRedirectFor(fakeRequest('HEAD', '/reports'))).toBe('/login?next=%2Freports');
  });

  test('a GET for an off-origin target falls back to the task list', () => {
    expect(loginRedirectFor(fakeRequest('GET', '//evil.example/tasks'))).toBe(
      '/login?next=%2Ftasks',
    );
  });

  test.each<{ method: string; originalUrl: string }>([
    { method: 'POST', originalUrl: '/tasks/1/edit' },
    { method: 'POST', originalUrl: '/tasks/1/delete' },
    { method: 'POST', originalUrl: '/tasks/1/status' },
    { method: 'PUT', originalUrl: '/tasks/1/edit' },
    { method: 'DELETE', originalUrl: '/tasks/1' },
  ])('a $method to $originalUrl is never replayed after login', ({ method, originalUrl }) => {
    expect(loginRedirectFor(fakeRequest(method, originalUrl))).toBe('/login?next=%2Ftasks');
  });
});

describe('parseListFilters', () => {
  test.each<{ name: string; query: unknown; filters: TaskFilters }>([
    {
      name: 'both echoes omitted, as from the delete confirmation form',
      query: echo({ confirm: 'yes', _csrf: 'x' }),
      filters: {},
    },
    {
      name: 'only the status echo posted',
      query: echo({ filterStatus: 'Done' }),
      filters: { status: 'Done' },
    },
    {
      name: 'both echoes posted',
      query: echo({ filterStatus: 'In progress', filterPriority: 'High' }),
      filters: { status: 'In progress', priority: 'High' },
    },
    {
      name: 'both echoes posted empty',
      query: echo({ filterStatus: '', filterPriority: '' }),
      filters: {},
    },
    {
      name: 'own keys holding undefined on a null-prototype object',
      query: nullPrototype({ status: undefined, priority: undefined }),
      filters: {},
    },
  ])('returns only the filters that are set for $name', ({ query, filters }) => {
    // toStrictEqual fails on a key holding undefined, so an absent filter must be omitted.
    expect(parseListFilters(query)).toStrictEqual(filters);
  });

  test.each<{ name: string; query: unknown }>([
    { name: 'an unknown status echo \'done\'', query: echo({ filterStatus: 'done' }) },
    { name: 'an unknown priority echo \'Urgent\'', query: echo({ filterPriority: 'Urgent' }) },
    { name: 'a repeated status echo', query: echo({ filterStatus: ['Done', 'To do'] }) },
    { name: 'a null status', query: { status: null } },
    { name: 'a number priority', query: { priority: 3 } },
  ])('throws BadRequestError for $name', ({ query }) => {
    expectBadRequest(() => parseListFilters(query));
  });
});

describe('readField', () => {
  test.each<{ name: string; source: unknown }>([
    { name: 'an own key holding undefined', source: { title: undefined } },
    { name: 'an inherited key', source: Object.create({ title: 'Buy milk' }) as object },
  ])('returns undefined for $name', ({ source }) => {
    expect(readField(source, 'title')).toBeUndefined();
  });

  test('returns the value untrimmed', () => {
    expect(readField({ title: '  Buy milk  ' }, 'title')).toBe('  Buy milk  ');
  });

  test('throws BadRequestError for a repeated parameter', () => {
    expectBadRequest(() => readField({ title: ['Buy milk', 'Buy bread'] }, 'title'));
  });
});

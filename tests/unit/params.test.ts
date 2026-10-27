/**
 * Unit tests of the request field reader and the list-filter parser (pure functions, no database).
 *
 * An empty or absent filter value means no filter, and an unknown value or a repeated parameter
 * is malformed (400). The status-change and delete routes validate the posted filter echoes by
 * passing `{ status: body.filterStatus, priority: body.filterPriority }`, so an echo that was not
 * posted reaches the parser as an own key holding `undefined`. That key is absent: it sets no
 * filter instead of throwing, while every other non-string value is still malformed.
 */

import { parseListFilters, readField } from '../../src/web/validation/params';
import { BadRequestError } from '../../src/shared/errors';
import type { TaskFilters } from '../../src/tasks/types';

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
    { name: "an unknown status echo 'done'", query: echo({ filterStatus: 'done' }) },
    { name: "an unknown priority echo 'Urgent'", query: echo({ filterPriority: 'Urgent' }) },
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

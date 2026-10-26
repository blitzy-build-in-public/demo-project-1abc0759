/**
 * Unit tests of the task form parser and the storable-text guard (pure functions, no database).
 *
 * A malformed request returns 400 and changes no data. PostgreSQL text cannot store U+0000, so a
 * title or description holding one must throw `BadRequestError` before any field rule runs,
 * instead of being accepted and failing in the database with a 500. U+0000 in the status,
 * priority or due date still gives that field's inline message, because those fields reach SQL
 * only as an exact label or a valid date. Valid text passes through unchanged.
 */

import {
  DESCRIPTION_TOO_LONG_MESSAGE,
  INVALID_DATE_MESSAGE,
  INVALID_PRIORITY_MESSAGE,
  INVALID_STATUS_MESSAGE,
  parseTaskForm,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
} from '../../src/web/validation/task-form';
import type { TaskFormValues } from '../../src/web/validation/task-form';
import { assertStorableText } from '../../src/web/validation/params';
import { BadRequestError } from '../../src/shared/errors';
import type { TaskInput } from '../../src/tasks/types';

/** U+1F600, a character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const ASTRAL = '\u{1F600}';

/** A title of exactly 200 code points (300 UTF-16 units), the longest accepted. */
const TITLE_200 = ASTRAL.repeat(100) + 'a'.repeat(100);

/** A title of 201 code points, one over the limit. */
const TITLE_201 = TITLE_200 + 'a';

/** A description of exactly 5,000 code points (10,000 UTF-16 units), the longest accepted. */
const DESCRIPTION_5000 = ASTRAL.repeat(5000);

/** A description of 5,001 code points, one over the limit. */
const DESCRIPTION_5001 = DESCRIPTION_5000 + ASTRAL;

/** The re-render values of a form whose fields were all absent. */
const EMPTY_VALUES: TaskFormValues = {
  title: '',
  description: '',
  status: '',
  priority: '',
  dueDate: '',
};

/** The validated input of a form that submitted only the title `Buy milk`. */
const DEFAULT_INPUT: TaskInput = {
  title: 'Buy milk',
  description: '',
  status: 'To do',
  priority: 'Medium',
  dueDate: null,
};

/**
 * Asserts that `run` throws the malformed-request error the error handler renders as 400
 * "Bad request.".
 */
function expectBadRequest(run: () => unknown): void {
  expect(run).toThrow(BadRequestError);
  expect(run).toThrow(expect.objectContaining({ status: 400, publicMessage: 'Bad request.' }));
}

describe('parseTaskForm', () => {
  test.each<{ name: string; body: Readonly<Record<string, string | readonly string[]>> }>([
    { name: 'a title containing U+0000', body: { title: 'a\u0000b' } },
    { name: 'a title that is only U+0000', body: { title: '\u0000' } },
    {
      name: 'a description containing U+0000 beside a valid title',
      body: { title: 'Buy milk', description: 'a\u0000b' },
    },
    {
      name: 'a U+0000 title beside a too-long description and an invalid due date',
      body: { title: 'a\u0000b', description: DESCRIPTION_5001, dueDate: '2026-02-29' },
    },
    { name: 'a repeated title', body: { title: ['Buy milk', 'a\u0000b'] } },
  ])('throws BadRequestError for $name', ({ body }) => {
    expectBadRequest(() => parseTaskForm(body));
  });

  test.each<{ name: string; body: Partial<TaskFormValues>; value: TaskInput }>([
    {
      name: 'a title with surrounding spaces, trimmed, with every other field defaulted',
      body: { title: '  Buy milk  ' },
      value: DEFAULT_INPUT,
    },
    {
      name: 'every field set to a valid value',
      body: {
        title: 'Buy milk',
        description: 'Semi-skimmed',
        status: 'Done',
        priority: 'High',
        dueDate: '2026-01-01',
      },
      value: {
        title: 'Buy milk',
        description: 'Semi-skimmed',
        status: 'Done',
        priority: 'High',
        dueDate: '2026-01-01',
      },
    },
    {
      name: 'a description with a CRLF line break, kept exactly',
      body: { title: 'Buy milk', description: 'line1\r\nline2' },
      value: { ...DEFAULT_INPUT, description: 'line1\r\nline2' },
    },
    {
      name: 'a title of 200 code points in 300 UTF-16 units',
      body: { title: TITLE_200 },
      value: { ...DEFAULT_INPUT, title: TITLE_200 },
    },
    {
      name: 'a description of 5,000 code points in 10,000 UTF-16 units',
      body: { title: 'Buy milk', description: DESCRIPTION_5000 },
      value: { ...DEFAULT_INPUT, description: DESCRIPTION_5000 },
    },
  ])('accepts $name', ({ body, value }) => {
    expect(parseTaskForm(body)).toEqual({ ok: true, value });
  });

  // Failures keep the raw submitted strings, with '' for an absent field, so the page can
  // re-render what was entered.
  test.each<{
    name: string;
    body: Partial<TaskFormValues>;
    errors: Partial<Record<keyof TaskFormValues, string>>;
  }>([
    {
      name: 'a status containing U+0000',
      body: { title: 'Buy milk', status: 'To\u0000do' },
      errors: { status: INVALID_STATUS_MESSAGE },
    },
    {
      name: 'a priority containing U+0000',
      body: { title: 'Buy milk', priority: 'Hi\u0000gh' },
      errors: { priority: INVALID_PRIORITY_MESSAGE },
    },
    {
      name: 'a due date containing U+0000',
      body: { title: 'Buy milk', dueDate: '2026-01-01\u0000' },
      errors: { dueDate: INVALID_DATE_MESSAGE },
    },
    {
      name: 'a title of 201 code points',
      body: { title: TITLE_201 },
      errors: { title: TITLE_TOO_LONG_MESSAGE },
    },
    {
      name: 'a description of 5,001 code points',
      body: { title: 'Buy milk', description: DESCRIPTION_5001 },
      errors: { description: DESCRIPTION_TOO_LONG_MESSAGE },
    },
    {
      name: 'an empty body',
      body: {},
      errors: { title: TITLE_REQUIRED_MESSAGE },
    },
  ])('returns only the inline message for $name, with the raw values', ({ body, errors }) => {
    expect(parseTaskForm(body)).toEqual({
      ok: false,
      errors,
      values: { ...EMPTY_VALUES, ...body },
    });
  });
});

describe('assertStorableText', () => {
  test.each(['', 'plain text'])('accepts %p', (text) => {
    expect(() => assertStorableText(text)).not.toThrow();
  });

  test('throws BadRequestError for text containing U+0000', () => {
    expectBadRequest(() => assertStorableText('a\u0000'));
  });
});

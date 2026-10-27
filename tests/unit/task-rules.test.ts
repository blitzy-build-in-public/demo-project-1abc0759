/**
 * Unit tests of the task vocabularies, the pure task rules and the task form parser that applies
 * them (no database, no real clock).
 *
 * Covers the status and priority defaults, the field limits, every completion-time transition of
 * `nextCompletedAt` (creation as `Done`, entering `Done`, staying `Done`, leaving `Done` and moves
 * between open statuses), and `buildTaskUpdate`: a priority-only change between every pair of
 * priorities, in each of the three statuses, keeps the status and the completion time (set or
 * `null`) unchanged and sets `updatedAt` to now.
 *
 * `parseTaskForm` is where a submitted form takes those defaults and limits. Only a missing status
 * or priority takes its default, which the re-render values then hold; a blank one was submitted,
 * so it gets its inline message and stays `''`. A malformed request returns 400 and changes no
 * data. PostgreSQL text cannot store U+0000, so a title or description holding one must throw
 * `BadRequestError` before any field rule runs, instead of being accepted and failing in the
 * database with a 500. U+0000 in the status, priority or due date still gives
 * that field's inline message, because those fields reach SQL only as an exact label or a valid
 * date. `assertStorableText` lets valid text through unchanged. On an edit, a title that equals
 * the stored one once its line breaks are written as CRLF, as a browser submits them, is the
 * stored title, kept exactly; any other title is taken as submitted.
 */

import {
  buildTaskUpdate,
  DESCRIPTION_MAX_CHARS,
  nextCompletedAt,
  TITLE_MAX_CHARS,
} from '../../src/tasks/task-rules';
import {
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  isTaskPriority,
  isTaskStatus,
  OPEN_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../../src/shared/task-values';
import { BadRequestError } from '../../src/shared/errors';
import { assertStorableText } from '../../src/web/validation/params';
import {
  DESCRIPTION_TOO_LONG_MESSAGE,
  INVALID_DATE_MESSAGE,
  INVALID_PRIORITY_MESSAGE,
  INVALID_STATUS_MESSAGE,
  parseTaskForm,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
} from '../../src/web/validation/task-form';
import type { TaskPriority, TaskStatus } from '../../src/shared/task-values';
import type { TaskInput } from '../../src/tasks/types';
import type { TaskUpdateRow } from '../../src/db/types';
import type { TaskFormValues } from '../../src/web/validation/task-form';

/** The instant a `Done` task originally completed. */
const T0 = new Date('2026-10-01T08:00:00.000Z');

/** The current instant passed as `now` to every rule. */
const NOW = new Date('2026-10-21T09:15:30.123Z');

/** The stored completion time that goes with a status: set exactly when the task is `Done`. */
function storedCompletedAt(status: TaskStatus): Date | null {
  return status === 'Done' ? T0 : null;
}

describe('task vocabularies, defaults and limits', () => {
  it('defaults new tasks to To do and Medium', () => {
    expect(DEFAULT_STATUS).toBe('To do');
    expect(DEFAULT_PRIORITY).toBe('Medium');
  });

  it('lists the statuses, priorities and open statuses in display order', () => {
    expect(TASK_STATUSES).toEqual(['To do', 'In progress', 'Done']);
    expect(TASK_PRIORITIES).toEqual(['Low', 'Medium', 'High']);
    expect(OPEN_STATUSES).toEqual(['To do', 'In progress']);
  });

  it.each(TASK_STATUSES.map((status): [string] => [status]))(
    'isTaskStatus accepts the exact label %p',
    (label) => {
      expect(isTaskStatus(label)).toBe(true);
    },
  );

  it.each<[unknown]>([['done'], ['To Do'], ['Todo'], [''], [undefined], [1]])(
    'isTaskStatus rejects %p',
    (value) => {
      expect(isTaskStatus(value)).toBe(false);
    },
  );

  it.each(TASK_PRIORITIES.map((priority): [string] => [priority]))(
    'isTaskPriority accepts the exact label %p',
    (label) => {
      expect(isTaskPriority(label)).toBe(true);
    },
  );

  it.each<[unknown]>([['high'], ['Urgent'], [''], [null]])('isTaskPriority rejects %p', (value) => {
    expect(isTaskPriority(value)).toBe(false);
  });

  it('limits titles to 200 and descriptions to 5,000 characters', () => {
    expect(TITLE_MAX_CHARS).toBe(200);
    expect(DESCRIPTION_MAX_CHARS).toBe(5000);
  });
});

describe('nextCompletedAt', () => {
  /** The stored state a transition starts from, or `null` for a task being created. */
  type Previous = { status: TaskStatus; completedAt: Date | null } | null;

  /** Case name, previous state, next status and the expected completion time. */
  const transitions: Array<[string, Previous, TaskStatus, Date | null]> = [
    ['creation as Done records now', null, 'Done', NOW],
    ['creation as To do records nothing', null, 'To do', null],
    ['creation as In progress records nothing', null, 'In progress', null],
    ['To do → Done records now', { status: 'To do', completedAt: null }, 'Done', NOW],
    ['In progress → Done records now', { status: 'In progress', completedAt: null }, 'Done', NOW],
    ['Done → Done keeps the original time', { status: 'Done', completedAt: T0 }, 'Done', T0],
    ['Done → To do clears the time', { status: 'Done', completedAt: T0 }, 'To do', null],
    [
      'Done → In progress clears the time',
      { status: 'Done', completedAt: T0 },
      'In progress',
      null,
    ],
    [
      'To do → In progress stays empty',
      { status: 'To do', completedAt: null },
      'In progress',
      null,
    ],
    [
      'In progress → To do stays empty',
      { status: 'In progress', completedAt: null },
      'To do',
      null,
    ],
    ['To do → To do stays empty', { status: 'To do', completedAt: null }, 'To do', null],
    [
      'In progress → In progress stays empty',
      { status: 'In progress', completedAt: null },
      'In progress',
      null,
    ],
  ];

  it('covers every transition between the three statuses plus creation in each', () => {
    const covered = new Set(
      transitions.map(([, previous, next]) => `${previous?.status ?? 'new'}→${next}`),
    );
    expect(covered.size).toBe(transitions.length);
    expect(covered.size).toBe((TASK_STATUSES.length + 1) * TASK_STATUSES.length);
  });

  it.each(transitions)('%s', (_name, previous, next, expected) => {
    expect(nextCompletedAt(previous, next, NOW)).toEqual(expected);
  });

  it('keeps the original completion time of a task that stays Done, not now', () => {
    const result = nextCompletedAt({ status: 'Done', completedAt: T0 }, 'Done', NOW);
    expect(result).not.toBeNull();
    expect(result?.getTime()).toBe(T0.getTime());
    expect(result?.getTime()).not.toBe(NOW.getTime());
  });
});

describe('buildTaskUpdate', () => {
  /** Status, the task's previous priority and the new priority, which always differ. */
  const priorityChanges: Array<[TaskStatus, TaskPriority, TaskPriority]> = TASK_STATUSES.flatMap(
    (status) =>
      TASK_PRIORITIES.flatMap((from) =>
        TASK_PRIORITIES.filter((to) => to !== from).map(
          (to): [TaskStatus, TaskPriority, TaskPriority] => [status, from, to],
        ),
      ),
  );

  it('generates a priority change between every pair of priorities in each status', () => {
    expect(priorityChanges).toHaveLength(18);
  });

  // `current` carries no priority, so `from` appears only in the case name: the rule must give the
  // same row whatever the previous priority was.
  it.each(priorityChanges)(
    '%s: %s → %s keeps status and completedAt',
    (status, _from, to) => {
      const current = { status, completedAt: storedCompletedAt(status) };
      const input: TaskInput = {
        title: 'Write report',
        description: 'Line 1\nLine 2',
        status,
        priority: to,
        dueDate: '2026-10-30',
      };
      const expected: TaskUpdateRow = {
        title: 'Write report',
        description: 'Line 1\nLine 2',
        status,
        priority: to,
        dueDate: '2026-10-30',
        completedAt: storedCompletedAt(status),
        updatedAt: NOW,
      };

      const row = buildTaskUpdate(current, input, NOW);

      expect(row).toEqual(expected);
      expect(row.status).toBe(current.status);
      expect(row.completedAt?.getTime() ?? null).toBe(current.completedAt?.getTime() ?? null);
    },
  );

  it('copies every input field on a full edit into Done and records now', () => {
    const input: TaskInput = {
      title: 'Ship release, then "celebrate"',
      description: 'Checklist:\r\n- tag\r\n- deploy',
      status: 'Done',
      priority: 'High',
      dueDate: null,
    };

    const row = buildTaskUpdate({ status: 'To do', completedAt: null }, input, NOW);

    expect(row).toEqual({
      title: 'Ship release, then "celebrate"',
      description: 'Checklist:\r\n- tag\r\n- deploy',
      status: 'Done',
      priority: 'High',
      dueDate: null,
      completedAt: NOW,
      updatedAt: NOW,
    });
  });

  it('clears the completion time when a Done task moves to In progress', () => {
    const input: TaskInput = {
      title: 'Write report',
      description: '',
      status: 'In progress',
      priority: 'Medium',
      dueDate: '2026-10-30',
    };

    const row = buildTaskUpdate({ status: 'Done', completedAt: T0 }, input, NOW);

    expect(row.status).toBe('In progress');
    expect(row.completedAt).toBeNull();
    expect(row.updatedAt).toEqual(NOW);
  });

  it('keeps the original completion time when only the title of a Done task changes', () => {
    const input: TaskInput = {
      title: 'Write the final report',
      description: '',
      status: 'Done',
      priority: 'Low',
      dueDate: null,
    };

    const row = buildTaskUpdate({ status: 'Done', completedAt: T0 }, input, NOW);

    expect(row.title).toBe('Write the final report');
    expect(row.completedAt).toEqual(T0);
    expect(row.updatedAt).toEqual(NOW);
  });

  it('returns exactly the updatable fields, so no id, owner or creation time leaks through', () => {
    const input: TaskInput = {
      title: 'Write report',
      description: '',
      status: 'To do',
      priority: 'Medium',
      dueDate: null,
    };

    const row = buildTaskUpdate({ status: 'To do', completedAt: null }, input, NOW);

    expect(Object.keys(row).sort()).toEqual([
      'completedAt',
      'description',
      'dueDate',
      'priority',
      'status',
      'title',
      'updatedAt',
    ]);
  });
});

/** The inline task-form messages, written out so the suite does not trust the constants. */
const TITLE_REQUIRED_TEXT = 'Title is required.';
const TITLE_TOO_LONG_TEXT = 'Title must be at most 200 characters.';
const DESCRIPTION_TOO_LONG_TEXT = 'Description must be at most 5,000 characters.';
const INVALID_DATE_TEXT = 'Enter a valid date (YYYY-MM-DD).';
const INVALID_STATUS_TEXT = 'Choose a valid status.';
const INVALID_PRIORITY_TEXT = 'Choose a valid priority.';

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

/** A title of exactly 200 code points holding one LF, the longest accepted with a line break. */
const TITLE_200_LF = 'a'.repeat(100) + '\n' + 'b'.repeat(99);

/** {@link TITLE_200_LF} as a browser submits it, the LF written as CRLF: 201 code points. */
const TITLE_200_LF_SUBMITTED = 'a'.repeat(100) + '\r\n' + 'b'.repeat(99);

/**
 * The re-render values of a form whose fields were all absent: the default status and priority,
 * and `''` for the text fields.
 */
const ABSENT_VALUES: TaskFormValues = {
  title: '',
  description: '',
  status: 'To do',
  priority: 'Medium',
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

describe('task form messages', () => {
  it.each<{ name: string; actual: string; expected: string }>([
    {
      name: 'TITLE_REQUIRED_MESSAGE',
      actual: TITLE_REQUIRED_MESSAGE,
      expected: TITLE_REQUIRED_TEXT,
    },
    {
      name: 'TITLE_TOO_LONG_MESSAGE',
      actual: TITLE_TOO_LONG_MESSAGE,
      expected: TITLE_TOO_LONG_TEXT,
    },
    {
      name: 'DESCRIPTION_TOO_LONG_MESSAGE',
      actual: DESCRIPTION_TOO_LONG_MESSAGE,
      expected: DESCRIPTION_TOO_LONG_TEXT,
    },
    { name: 'INVALID_DATE_MESSAGE', actual: INVALID_DATE_MESSAGE, expected: INVALID_DATE_TEXT },
    {
      name: 'INVALID_STATUS_MESSAGE',
      actual: INVALID_STATUS_MESSAGE,
      expected: INVALID_STATUS_TEXT,
    },
    {
      name: 'INVALID_PRIORITY_MESSAGE',
      actual: INVALID_PRIORITY_MESSAGE,
      expected: INVALID_PRIORITY_TEXT,
    },
  ])('$name is $expected', ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });
});

describe('parseTaskForm', () => {
  it.each<{ name: string; body: Readonly<Record<string, string | readonly string[]>> }>([
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

  it.each<{ name: string; body: Partial<TaskFormValues>; value: TaskInput }>([
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
    {
      name: 'a blank description and due date, which mean none',
      body: { title: 'Buy milk', description: '', dueDate: '' },
      value: DEFAULT_INPUT,
    },
  ])('accepts $name', ({ body, value }) => {
    expect(parseTaskForm(body)).toEqual({ ok: true, value });
  });

  // Failures keep the raw submitted strings, with '' for an absent text field and the default for
  // an absent status or priority, so the page can re-render what was entered.
  it.each<{
    name: string;
    body: Partial<TaskFormValues>;
    errors: Partial<Record<keyof TaskFormValues, string>>;
  }>([
    {
      name: 'a status containing U+0000',
      body: { title: 'Buy milk', status: 'To\u0000do' },
      errors: { status: INVALID_STATUS_TEXT },
    },
    {
      name: 'a priority containing U+0000',
      body: { title: 'Buy milk', priority: 'Hi\u0000gh' },
      errors: { priority: INVALID_PRIORITY_TEXT },
    },
    {
      name: 'a due date containing U+0000',
      body: { title: 'Buy milk', dueDate: '2026-01-01\u0000' },
      errors: { dueDate: INVALID_DATE_TEXT },
    },
    {
      name: 'a title of 201 code points',
      body: { title: TITLE_201 },
      errors: { title: TITLE_TOO_LONG_TEXT },
    },
    {
      name: 'a 201-code-point title holding a CRLF line break, with no stored title',
      body: { title: TITLE_200_LF_SUBMITTED },
      errors: { title: TITLE_TOO_LONG_TEXT },
    },
    {
      name: 'a description of 5,001 code points',
      body: { title: 'Buy milk', description: DESCRIPTION_5001 },
      errors: { description: DESCRIPTION_TOO_LONG_TEXT },
    },
    {
      name: 'an empty body',
      body: {},
      errors: { title: TITLE_REQUIRED_TEXT },
    },
    {
      name: 'a blank status',
      body: { title: 'Buy milk', status: '' },
      errors: { status: INVALID_STATUS_TEXT },
    },
    {
      name: 'a blank priority',
      body: { title: 'Buy milk', priority: '' },
      errors: { priority: INVALID_PRIORITY_TEXT },
    },
    {
      name: 'a blank title, status and priority',
      body: { title: '', status: '', priority: '' },
      errors: {
        title: TITLE_REQUIRED_TEXT,
        status: INVALID_STATUS_TEXT,
        priority: INVALID_PRIORITY_TEXT,
      },
    },
  ])('returns only the inline message for $name, with the raw values', ({ body, errors }) => {
    expect(parseTaskForm(body)).toEqual({
      ok: false,
      errors,
      values: { ...ABSENT_VALUES, ...body },
    });
  });

  it('builds the line-break boundary title of 200 code points, submitted as 201', () => {
    expect([...TITLE_200_LF]).toHaveLength(200);
    expect([...TITLE_200_LF_SUBMITTED]).toHaveLength(201);
  });

  // A browser submits every line break as CRLF, so on an edit a title equal to the stored one in
  // that form is the stored title left alone; any other submission is taken as sent.
  it.each<{ name: string; storedTitle: string | undefined; title: string; value: string }>([
    {
      name: 'an unchanged LF title submitted with CRLF as stored',
      storedTitle: 'Plan\nreview',
      title: 'Plan\r\nreview',
      value: 'Plan\nreview',
    },
    {
      name: 'an unchanged CR title submitted with CRLF as stored',
      storedTitle: 'Plan\rreview',
      title: 'Plan\r\nreview',
      value: 'Plan\rreview',
    },
    {
      name: 'an unchanged CRLF title as stored',
      storedTitle: 'Plan\r\nreview',
      title: 'Plan\r\nreview',
      value: 'Plan\r\nreview',
    },
    {
      name: 'an unchanged title mixing CR, LF and CRLF, submitted with CRLF, as stored',
      storedTitle: 'a\rb\nc\r\nd',
      title: 'a\r\nb\r\nc\r\nd',
      value: 'a\rb\nc\r\nd',
    },
    {
      name: 'an unchanged 200-code-point LF title submitted as 201 code points as stored',
      storedTitle: TITLE_200_LF,
      title: TITLE_200_LF_SUBMITTED,
      value: TITLE_200_LF,
    },
    {
      name: 'an LF title sent with its LF as stored',
      storedTitle: 'Plan\nreview',
      title: 'Plan\nreview',
      value: 'Plan\nreview',
    },
    {
      name: 'an edited LF title as submitted, with CRLF',
      storedTitle: 'Plan\nreview',
      title: 'Plan\r\nreviews',
      value: 'Plan\r\nreviews',
    },
    {
      name: 'an LF title edited to drop its line break as submitted',
      storedTitle: 'Plan\nreview',
      title: 'Plan review',
      value: 'Plan review',
    },
    {
      name: 'a CRLF title edited to LF as submitted',
      storedTitle: 'Plan\r\nreview',
      title: 'Plan\nreview',
      value: 'Plan\nreview',
    },
    {
      name: 'a CRLF title with no stored title as submitted',
      storedTitle: undefined,
      title: 'Plan\r\nreview',
      value: 'Plan\r\nreview',
    },
  ])('takes $name', ({ storedTitle, title, value }) => {
    expect(parseTaskForm({ title, priority: 'High' }, storedTitle)).toEqual({
      ok: true,
      value: { ...DEFAULT_INPUT, title: value, priority: 'High' },
    });
  });

  it.each<{ name: string; storedTitle: string; title: string }>([
    { name: 'LF', storedTitle: 'Plan\nreview', title: 'Plan\r\nreview' },
    { name: 'CR', storedTitle: 'Plan\rreview', title: 'Plan\r\nreview' },
    { name: '200-code-point LF', storedTitle: TITLE_200_LF, title: TITLE_200_LF_SUBMITTED },
  ])('re-renders the unchanged $name title of a refused edit as stored', (c) => {
    expect(parseTaskForm({ title: c.title, dueDate: '2026-02-30' }, c.storedTitle)).toEqual({
      ok: false,
      errors: { dueDate: INVALID_DATE_TEXT },
      values: { ...ABSENT_VALUES, title: c.storedTitle, dueDate: '2026-02-30' },
    });
  });
});

describe('assertStorableText', () => {
  it.each(['', 'plain text'])('accepts %p', (text) => {
    expect(() => assertStorableText(text)).not.toThrow();
  });

  it('throws BadRequestError for text containing U+0000', () => {
    expectBadRequest(() => assertStorableText('a\u0000'));
  });
});

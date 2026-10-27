/**
 * Unit tests of the task vocabularies and the pure task rules (no database, no real clock).
 *
 * Covers the status and priority defaults, the field limits, every completion-time transition of
 * `nextCompletedAt` (creation as `Done`, entering `Done`, staying `Done`, leaving `Done` and moves
 * between open statuses), and `buildTaskUpdate`: a priority-only change between every pair of
 * priorities, in each of the three statuses, keeps the status and the completion time (set or
 * `null`) unchanged and sets `updatedAt` to now.
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
import type { TaskPriority, TaskStatus } from '../../src/shared/task-values';
import type { TaskInput } from '../../src/tasks/types';
import type { TaskUpdateRow } from '../../src/db/types';

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

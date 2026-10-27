/**
 * Unit tests of the summary report rules (pure functions, no database, no clock).
 *
 * A task is overdue when its due date is earlier than today (UTC) and its status is not `Done`: a
 * task due today is not overdue and an undated task never is. `summarize` counts the open groups
 * the data-access layer returns by status, by priority and as overdue, and with no groups every
 * count is 0. "Today" is always an explicit `YYYY-MM-DD` string.
 */

import { isOverdue, summarize } from '../../src/reports/summary';
import type { SummaryReport } from '../../src/reports/summary';
import type { OpenTaskGroup } from '../../src/db/types';
import type { TaskStatus } from '../../src/shared/task-values';

describe('isOverdue', () => {
  test.each<{
    name: string;
    dueDate: string | null;
    status: TaskStatus;
    today: string;
    expected: boolean;
  }>([
    {
      name: 'due yesterday and To do',
      dueDate: '2026-10-20',
      status: 'To do',
      today: '2026-10-21',
      expected: true,
    },
    {
      name: 'due yesterday and In progress',
      dueDate: '2026-10-20',
      status: 'In progress',
      today: '2026-10-21',
      expected: true,
    },
    {
      name: 'due today',
      dueDate: '2026-10-21',
      status: 'To do',
      today: '2026-10-21',
      expected: false,
    },
    {
      name: 'due tomorrow',
      dueDate: '2026-10-22',
      status: 'In progress',
      today: '2026-10-21',
      expected: false,
    },
    {
      name: 'Done with a past due date',
      dueDate: '2026-10-01',
      status: 'Done',
      today: '2026-10-21',
      expected: false,
    },
    {
      name: 'undated and To do',
      dueDate: null,
      status: 'To do',
      today: '2026-10-21',
      expected: false,
    },
    {
      name: 'undated and In progress',
      dueDate: null,
      status: 'In progress',
      today: '2026-10-21',
      expected: false,
    },
    {
      name: 'due on the last day of the previous year',
      dueDate: '2025-12-31',
      status: 'To do',
      today: '2026-01-01',
      expected: true,
    },
    {
      name: 'due on the earliest representable day',
      dueDate: '0001-01-01',
      status: 'To do',
      today: '2026-10-21',
      expected: true,
    },
    {
      name: 'due on the latest representable day',
      dueDate: '9999-12-31',
      status: 'To do',
      today: '2026-10-21',
      expected: false,
    },
  ])('$name: $expected', ({ dueDate, status, today, expected }) => {
    expect(isOverdue(dueDate, status, today)).toBe(expected);
  });
});

describe('summarize', () => {
  /** A mix of open groups with weighted counts, judged against today = 2026-10-21. */
  const groups: readonly OpenTaskGroup[] = [
    { status: 'To do', priority: 'High', dueDate: '2026-10-20', count: 3 },
    { status: 'To do', priority: 'Low', dueDate: null, count: 2 },
    { status: 'In progress', priority: 'Medium', dueDate: '2026-10-21', count: 4 },
    { status: 'In progress', priority: 'High', dueDate: '2026-01-01', count: 1 },
    { status: 'To do', priority: 'Medium', dueDate: '2026-12-01', count: 5 },
  ];

  /** Adds the numeric values of a count map. */
  function total(counts: Readonly<Record<string, number>>): number {
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  test('returns every count as 0 when there are no groups', () => {
    const expected: SummaryReport = {
      openByStatus: { 'To do': 0, 'In progress': 0 },
      openByPriority: { Low: 0, Medium: 0, High: 0 },
      overdue: 0,
    };

    expect(summarize([], '2026-10-21')).toEqual(expected);
  });

  test('adds each group count to its status, its priority and, if overdue, to overdue', () => {
    const expected: SummaryReport = {
      openByStatus: { 'To do': 10, 'In progress': 5 },
      openByPriority: { Low: 2, Medium: 9, High: 4 },
      overdue: 4,
    };

    expect(summarize(groups, '2026-10-21')).toEqual(expected);
  });

  test('counts every open task once by status and once by priority', () => {
    const report = summarize(groups, '2026-10-21');
    const taskCount = groups.reduce((sum, group) => sum + group.count, 0);

    expect(report.openByStatus['To do'] + report.openByStatus['In progress']).toBe(taskCount);
    expect(total(report.openByPriority)).toBe(taskCount);
  });

  test('counts a group due today as overdue once today moves past its due date', () => {
    expect(summarize(groups, '2026-10-22').overdue).toBe(8);
  });
});

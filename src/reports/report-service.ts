/**
 * Report service: the summary, the completions per day and the CSV export for one user.
 *
 * It holds no state. Each method issues one owner-scoped read through `dal.tasks` and hands the
 * rows to the pure rules in `./summary`, `./completions` and `./csv`; the aggregation itself runs
 * in SQL. The report module reads task data only through `TasksRepo`, never through the task
 * module, so the auth, task and report modules stay independent of each other.
 *
 * Inputs are trusted: the web layer validates ranges with `parseDateRange` and statuses with
 * `isTaskStatus` before calling. Errors from the data-access layer, `DatabaseUnavailableError`
 * included, propagate unchanged to the web layer's error handler, the one place that maps errors
 * to responses.
 */

import type { DataAccess } from '../db/data-access';
import type { UserId } from '../db/types';
import type { Clock } from '../shared/clock';
import type { DateRange, IsoDate } from '../shared/dates';
import { todayUtc } from '../shared/dates';
import type { TaskStatus } from '../shared/task-values';
import { zeroFillCompletions } from './completions';
import type { CompletionsReport } from './completions';
import { buildCsv, taskToCsvRow } from './csv';
import { summarize } from './summary';
import type { SummaryReport } from './summary';

/**
 * The reports available to a signed-in user, each scoped to the owner it is given.
 *
 * Every method passes `ownerId` straight to the repository, which filters on `owner_id`, so no
 * report ever includes another user's tasks.
 */
export interface ReportService {
  /**
   * Returns the current day in UTC, taken from the injected clock.
   *
   * This is the single source of "today" for the report routes: the default completions range,
   * range validation and the overdue rule all derive from it.
   *
   * @returns The current UTC day as `YYYY-MM-DD`.
   */
  today(): IsoDate;

  /**
   * Builds the summary report: open tasks by status, open tasks by priority, and overdue tasks.
   *
   * With no open tasks every count is 0.
   *
   * @param ownerId - The signed-in user.
   * @returns The owner's summary, with "overdue" judged against {@link ReportService.today}.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  summary(ownerId: UserId): Promise<SummaryReport>;

  /**
   * Builds the completions report: the number of tasks completed on each UTC day of the range.
   *
   * Every day of the range appears once, in order, with 0 for days without completions.
   *
   * @param ownerId - The signed-in user.
   * @param range - Inclusive range, already validated by `parseDateRange` (at most 366 days, `from`
   *   not after `to`).
   * @returns The zero-filled report and its total.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  completions(ownerId: UserId, range: DateRange): Promise<CompletionsReport>;

  /**
   * Builds the CSV export of the tasks created on any UTC day of the range.
   *
   * The body is the complete RFC 4180 file from `buildCsv`: byte-order mark, header row, then one
   * record per task in creation order. With no matching tasks it holds only the header row.
   *
   * @param ownerId - The signed-in user.
   * @param range - Inclusive range of creation days, already validated by `parseDateRange`.
   * @param status - Only tasks with exactly this status, already validated by `isTaskStatus`, or
   *   `null` for every status.
   * @returns The download file name, `tasks-<from>-to-<to>.csv`, and the file's text, to be sent
   *   as UTF-8.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  exportCsv(
    ownerId: UserId,
    range: DateRange,
    status: TaskStatus | null,
  ): Promise<{ filename: string; body: string }>;
}

/**
 * Creates the report service.
 *
 * @param deps - `dal`, whose `tasks` repository is the only one the service reads, and `clock`,
 *   the only source of the current time.
 * @returns A service that keeps no state and caches nothing between calls.
 */
export function createReportService(deps: { dal: DataAccess; clock: Clock }): ReportService {
  const { dal, clock } = deps;

  const today = (): IsoDate => todayUtc(clock.now());

  return {
    today,

    async summary(ownerId: UserId): Promise<SummaryReport> {
      const groups = await dal.tasks.openTaskGroups(ownerId);
      return summarize(groups, today());
    },

    async completions(ownerId: UserId, range: DateRange): Promise<CompletionsReport> {
      const rows = await dal.tasks.completionsByDay(ownerId, range);
      return zeroFillCompletions(range, rows);
    },

    async exportCsv(
      ownerId: UserId,
      range: DateRange,
      status: TaskStatus | null,
    ): Promise<{ filename: string; body: string }> {
      // The range goes to SQL as its two `YYYY-MM-DD` strings and the repository builds the UTC
      // timestamp bounds there, so the day after `range.to` (outside `IsoDate` for 9999-12-31) is
      // never computed here.
      const tasks = await dal.tasks.createdBetween(ownerId, range, status);
      return {
        filename: `tasks-${range.from}-to-${range.to}.csv`,
        body: buildCsv(tasks.map(taskToCsvRow)),
      };
    },
  };
}

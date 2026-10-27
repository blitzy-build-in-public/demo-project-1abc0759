/**
 * Report routes: the reports page (`GET /reports`) and the CSV export (`GET /reports/export`).
 *
 * Both routes are `GET`, change no state and carry no CSRF token; the page still receives the
 * response's token for the layout's Log out form. Every service call passes the signed-in user's
 * id, and the report service reads tasks only through the owner-scoped `TasksRepo`, so no report
 * includes another user's tasks. Malformed input (a repeated query parameter) throws
 * `BadRequestError` before any service call, and every error, `DatabaseUnavailableError`
 * included, is forwarded by `asyncHandler` to the error handler, which alone maps errors to
 * pages. Nothing here logs or renders an error.
 */

import express from 'express';
import type { Request, Response, Router } from 'express';

import type { AuthenticatedUser } from '../../auth/auth-service';
import { defaultRange, parseDateRange } from '../../reports/date-range';
import type { ReportService } from '../../reports/report-service';
import { asyncHandler } from '../async-handler';
import { csrfTokenOf } from '../csrf';
import { requireAuth } from '../middleware/require-auth';
import '../request-user';
import { renderReportsPage, type ReportsPageView } from '../templates/report-pages';
import { parseExportStatus, readField } from '../validation/params';

/** The export's media type: RFC 4180 `text/csv` with its `charset` and `header` parameters. */
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8; header=present';

/** Status of a page whose range or export form failed validation. */
const UNPROCESSABLE = 422;

/**
 * Returns the signed-in user. Every route here runs after `requireAuth`, so a missing user is
 * unreachable; it fails as a plain error (500) rather than through a non-null assertion.
 */
function currentUser(req: Request): AuthenticatedUser {
  const user = req.user;
  if (user === undefined) {
    throw new Error('Report route reached without a signed-in user');
  }
  return user;
}

/** Sends a complete HTML page with the given status. */
function sendHtml(res: Response, status: number, page: string): void {
  res.status(status).type('html').send(page);
}

/**
 * Reads the `from` and `to` query values as submitted, each `undefined` when absent.
 *
 * @throws `BadRequestError` (400) when either is repeated, which the `'simple'` query parser
 *   delivers as an array.
 */
function readRangeQuery(query: unknown): { from: string | undefined; to: string | undefined } {
  return { from: readField(query, 'from'), to: readField(query, 'to') };
}

/**
 * Creates the router for the reports page and the CSV export. It is mounted at the root, after
 * `loadSession`, the CSRF `prepare` middleware and `noStore`.
 *
 * - `GET /reports` (`from`, `to`, both or neither): always renders the summary. A valid range,
 *   or none (the default 30 days ending today, UTC), adds the completions table and chart with
 *   200. An invalid range answers 422 with its message and the dates as entered in place of the
 *   table and chart, and skips the completions query. The export form is prefilled with the
 *   default range and all statuses.
 * - `GET /reports/export` (`from`, `to`, `status`, which is `''` or a status label): with a valid
 *   range and status, answers 200 with the CSV file of the tasks created in the range, headers
 *   `Content-Type: text/csv; charset=utf-8; header=present`,
 *   `Content-Disposition: attachment; filename="tasks-<from>-to-<to>.csv"` and
 *   `Cache-Control: no-store`. An empty selection is the header-only file. Otherwise it sends no
 *   file and answers 422 with the reports page: the summary, the completions for the default
 *   range, and the export form holding the entered values and the message.
 *
 * Unauthenticated requests are redirected by `requireAuth` (302 to `/login?next=…`). A repeated
 * `from`, `to` or `status` parameter answers 400 "Bad request." through the error handler.
 *
 * @param deps - `reports`, the only service these routes call.
 * @returns The Express router.
 */
export function createReportRouter(deps: { reports: ReportService }): Router {
  const { reports } = deps;
  // Exact matching, as the application sets for itself: a router does not inherit it, and
  // `/REPORTS` or `/reports/export/` must reach the 404 handler rather than a route.
  const router = express.Router({ caseSensitive: true, strict: true });

  router.get(
    '/reports',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const { from, to } = readRangeQuery(req.query);
      const today = reports.today();
      const summary = await reports.summary(user.id);
      const parsed = parseDateRange({ from, to }, today);
      const completions: ReportsPageView['completions'] = parsed.ok
        ? { ok: true, report: await reports.completions(user.id, parsed.range) }
        : { ok: false, message: parsed.message, from: from ?? '', to: to ?? '' };
      const defaults = defaultRange(today);
      const view: ReportsPageView = {
        user,
        csrfToken: csrfTokenOf(res),
        summary,
        completions,
        exportForm: { from: defaults.from, to: defaults.to, status: '' },
      };
      sendHtml(res, parsed.ok ? 200 : UNPROCESSABLE, renderReportsPage(view));
    }),
  );

  router.get(
    '/reports/export',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const { from, to } = readRangeQuery(req.query);
      const status = readField(req.query, 'status');
      const today = reports.today();
      const range = parseDateRange({ from, to }, today);
      const statusResult = parseExportStatus(status);

      /** Renders the reports page with the failed export form; no file is sent. */
      const rejectExport = async (message: string): Promise<void> => {
        const summary = await reports.summary(user.id);
        const report = await reports.completions(user.id, defaultRange(today));
        const view: ReportsPageView = {
          user,
          csrfToken: csrfTokenOf(res),
          summary,
          completions: { ok: true, report },
          exportForm: { from: from ?? '', to: to ?? '', status: status ?? '', message },
        };
        sendHtml(res, UNPROCESSABLE, renderReportsPage(view));
      };

      // The range is checked before the status, so when both are invalid the page shows the
      // range message; the template flags the unknown status through its "(invalid)" option.
      if (!range.ok) {
        await rejectExport(range.message);
        return;
      }
      if (!statusResult.ok) {
        await rejectExport(statusResult.message);
        return;
      }

      const file = await reports.exportCsv(user.id, range.range, statusResult.status);
      res.status(200);
      res.set('Content-Type', CSV_CONTENT_TYPE);
      res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.set('Cache-Control', 'no-store');
      // A Buffer, not a string: for a string body Express 4 rewrites Content-Type through its
      // charset handling, while a Buffer leaves the header exactly as set above and sends the
      // body's bytes, byte-order mark and CRLFs included, unaltered. `res.attachment()` is not
      // used because it would replace the Content-Type with one looked up from the file name.
      res.send(Buffer.from(file.body, 'utf8'));
    }),
  );

  return router;
}

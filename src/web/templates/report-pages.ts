/**
 * The reports page: the summary counts, the completions per day (table, plus the hidden figure
 * that `completions-chart.js` fills with bars built from the table rows) and the CSV export form.
 *
 * Pure: the route supplies every date and value and chooses the status code (200 or 422); this
 * template only renders what the view holds. All dates are `YYYY-MM-DD` strings shown as given.
 */

import type { AuthenticatedUser } from '../../auth/auth-service';
import type { CompletionsReport } from '../../reports/completions';
import type { SummaryReport } from '../../reports/summary';
import { TASK_STATUSES } from '../../shared/task-values';
import { html, type SafeHtml } from './html';
import {
  dateInput,
  describedBy,
  renderLayout,
  selectOptions,
  type SelectOption,
} from './layout';

/** Everything the reports route passes to {@link renderReportsPage}. */
export interface ReportsPageView {
  /** The signed-in user, shown in the header. */
  user: AuthenticatedUser;
  /** The response's CSRF token, carried by the header's Log out form. */
  csrfToken: string;
  /** The summary counts. Rendered on every response, 422s included: it is not range-based. */
  summary: SummaryReport;
  /**
   * The completions section: the report for a valid range, or the range message together with
   * the dates exactly as entered (possibly empty or malformed), in which case the page shows the
   * message and no table or chart.
   */
  completions:
    | { ok: true; report: CompletionsReport }
    | { ok: false; message: string; from: string; to: string };
  /**
   * The export form: its range and status as prefilled or as entered, and the validation message
   * of a failed export (`undefined` or `''` when there is none). `status` is `''` for all
   * statuses; any value that is not a status label is shown as a selected "(invalid)" option.
   */
  exportForm: { from: string; to: string; status: string; message?: string };
}

/** Shown, beside the zero rows, when a valid range has no completions. */
const NO_COMPLETIONS_MESSAGE = 'No tasks were completed in this period.';

const COMPLETIONS_HINT_ID = 'completions-hint';
const COMPLETIONS_MESSAGE_ID = 'completions-message';
const EXPORT_HINT_ID = 'export-hint';
const EXPORT_MESSAGE_ID = 'export-message';

/** The export Status select: "All" (`''`, every status) followed by each status label. */
const EXPORT_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'All' },
  ...TASK_STATUSES.map((status) => ({ value: status, label: status })),
];

/**
 * Renders the complete reports page for `GET /reports` and for a failed `GET /reports/export`.
 *
 * - **Summary:** a definition list whose values carry the `data-testid`s `open-todo`,
 *   `open-in-progress`, `open-low`, `open-medium`, `open-high` and `overdue`. Each `<dd>` holds
 *   only the number, `0` included.
 * - **Completions:** a `GET /reports` range form prefilled with the reported range, or with the
 *   dates as entered when the range is invalid. For a valid range it renders
 *   `<figure id="completions-chart" hidden>`, holding only its caption, and
 *   `<table id="completions-table">` with one `tbody` row per day carrying `data-day` and
 *   `data-count`, plus "No tasks were completed in this period." when the total is 0. For an
 *   invalid range it renders the message and neither the figure nor the table.
 * - **Export:** a `GET /reports/export` form with From, To and Status, and the export message
 *   when `exportForm.message` is set.
 *
 * Invalid dates, blanks included (a range needs both dates), stay visible as text fields and an
 * unknown status as a selected "(invalid)" option, through the shared `dateInput` and
 * `selectOptions` helpers. Valid dates stay in date fields. Every value is escaped.
 *
 * @param view - The user, CSRF token, summary, completions result and export form state.
 * @returns The HTML document.
 */
export function renderReportsPage(view: ReportsPageView): string {
  const summary = summarySection(view.summary);
  const completions = completionsSection(view.completions);
  const exportForm = exportSection(view.exportForm);
  const body = html`
    <h1>Reports</h1>${summary}${completions}${exportForm}
`;
  return renderLayout({
    title: 'Reports',
    user: view.user,
    csrfToken: view.csrfToken,
    body,
    scripts: ['completions-chart'],
  });
}

/** The summary section. Each `<dd>` holds the bare number so tests can read it as text. */
function summarySection(summary: SummaryReport): SafeHtml {
  return html`
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Summary</h2>
      <dl>
        <dt>Open: To do</dt>
        <dd data-testid="open-todo">${summary.openByStatus['To do']}</dd>
        <dt>Open: In progress</dt>
        <dd data-testid="open-in-progress">${summary.openByStatus['In progress']}</dd>
        <dt>Open, Low priority</dt>
        <dd data-testid="open-low">${summary.openByPriority.Low}</dd>
        <dt>Open, Medium priority</dt>
        <dd data-testid="open-medium">${summary.openByPriority.Medium}</dd>
        <dt>Open, High priority</dt>
        <dd data-testid="open-high">${summary.openByPriority.High}</dd>
        <dt>Overdue</dt>
        <dd data-testid="overdue">${summary.overdue}</dd>
      </dl>
      <p class="hint">Open tasks are those in To do or In progress. Overdue counts open tasks due
        before today (UTC).</p>
    </section>`;
}

/**
 * The completions section: the range form, the message area, and for a valid range the chart
 * figure and the per-day table.
 */
function completionsSection(completions: ReportsPageView['completions']): SafeHtml {
  const from = completions.ok ? completions.report.range.from : completions.from;
  const to = completions.ok ? completions.report.range.to : completions.to;
  const hasMessage = !completions.ok || completions.report.total === 0;
  const described = [COMPLETIONS_HINT_ID, hasMessage && COMPLETIONS_MESSAGE_ID];
  const invalid = !completions.ok;
  // An invalid range focuses From, which announces the range message it is described by.
  const fromInput = dateInput({
    id: 'completions-from',
    name: 'from',
    value: from,
    describedBy: described,
    invalid,
    autofocus: invalid,
    emptyIsValid: false,
  });
  const toInput = dateInput({
    id: 'completions-to',
    name: 'to',
    value: to,
    describedBy: described,
    invalid,
    emptyIsValid: false,
  });
  const result = completions.ok
    ? completionsData(completions.report)
    : rangeError(completions.message);

  return html`
    <section aria-labelledby="completions-heading">
      <h2 id="completions-heading">Completed tasks per day</h2>
      <form method="get" action="/reports">
        <label for="completions-from">From</label>
        ${fromInput}
        <label for="completions-to">To</label>
        ${toInput}
        <button type="submit">Show</button>
        <p class="hint" id="${COMPLETIONS_HINT_ID}">Days are UTC calendar days, and both dates are
          included.</p>
      </form>${result}
    </section>`;
}

/**
 * The invalid-range message, shown where the table would be. An invalid range renders no data.
 *
 * It uses `role="alert"` rather than the `role="status"` of the empty-period notice: it is a
 * validation error, so it takes the same error semantics and styling as the export message.
 */
function rangeError(message: string): SafeHtml {
  return html`
      <p id="${COMPLETIONS_MESSAGE_ID}" class="message" role="alert">${message}</p>`;
}

/**
 * The empty-period notice (when the total is 0), the chart figure and the completions table.
 *
 * The figure stays `hidden` and holds only its caption: `completions-chart.js` appends the SVG,
 * one bar per `tbody` row, and then removes `hidden`, so without JavaScript the table alone is
 * the report. The header row sits in `<thead>` because the script reads only `tbody` rows.
 */
function completionsData(report: CompletionsReport): SafeHtml {
  const notice =
    report.total === 0 &&
    html`
      <p id="${COMPLETIONS_MESSAGE_ID}" class="message"
        role="status">${NO_COMPLETIONS_MESSAGE}</p>`;
  const rows = report.days.map(
    ({ day, count }) => html`
          <tr data-day="${day}" data-count="${count}">
            <th scope="row">${day}</th><td>${count}</td></tr>`,
  );
  const { from, to } = report.range;

  return html`${notice}
      <figure id="completions-chart" hidden>
        <figcaption>Tasks completed per day, ${from} to ${to} (UTC)</figcaption>
      </figure>
      <table id="completions-table" aria-labelledby="completions-heading">
        <thead>
          <tr><th scope="col">Date</th><th scope="col">Completed</th></tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>`;
}

/** The export section: the CSV form and, after a failed export, its message. */
function exportSection(form: ReportsPageView['exportForm']): SafeHtml {
  const message = form.message !== undefined && form.message !== '' ? form.message : null;
  const statusInvalid = !EXPORT_STATUS_OPTIONS.some((o) => o.value === form.status);
  // The route reports the range message ahead of the status message, so an unknown status
  // (shown as its "(invalid)" option) is flagged on the select and a message beside a valid
  // status can only be about the range.
  const rangeInvalid = message !== null && !statusInvalid;
  // The select is described by the message only when its own value is unknown. The dates are
  // described by any message: beside an unknown status it may still be the range message.
  const dateDescribed = [EXPORT_HINT_ID, message !== null && EXPORT_MESSAGE_ID];
  const selectDescribed = describedBy(statusInvalid && message !== null && EXPORT_MESSAGE_ID);
  // The export section sits below the completions table, far below the fold, so a failed export
  // focuses its invalid control: the browser scrolls to it and announces the linked message.
  // `statusInvalid` and `rangeInvalid` are exclusive, so exactly one control takes `autofocus`.
  const selectInvalid = statusInvalid && html` aria-invalid="true" autofocus`;
  const exportFrom = dateInput({
    id: 'export-from',
    name: 'from',
    value: form.from,
    describedBy: dateDescribed,
    invalid: rangeInvalid,
    autofocus: rangeInvalid,
    emptyIsValid: false,
  });
  const exportTo = dateInput({
    id: 'export-to',
    name: 'to',
    value: form.to,
    describedBy: dateDescribed,
    invalid: rangeInvalid,
    emptyIsValid: false,
  });
  const statusOptions = selectOptions(EXPORT_STATUS_OPTIONS, form.status);
  const messageArea =
    message !== null &&
    html`
      <p id="${EXPORT_MESSAGE_ID}" class="message" role="alert">${message}</p>`;

  return html`
    <section aria-labelledby="export-heading">
      <h2 id="export-heading">Export tasks (CSV)</h2>
      <form method="get" action="/reports/export">
        <label for="export-from">From</label>
        ${exportFrom}
        <label for="export-to">To</label>
        ${exportTo}
        <label for="export-status">Status</label>
        <select id="export-status" name="status"${selectDescribed}${selectInvalid}>
          ${statusOptions}
        </select>
        <button type="submit">Download CSV</button>
        <p class="hint" id="${EXPORT_HINT_ID}">Exports tasks created in this date range (UTC),
          both dates included.</p>
      </form>${messageArea}
    </section>`;
}

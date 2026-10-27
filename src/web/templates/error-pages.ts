/**
 * The page behind every failure response: 400, 403, 404, 413, 500 and 503.
 *
 * The page shows only the status, a fixed reason phrase, the caller's fixed message and a link to
 * `/tasks`. It never receives an error object, request data or the signed-in user, so no error
 * property, stack trace or SQL text can reach the browser, and two failures with the same status
 * and message produce byte-identical bodies whoever is signed in.
 */

import { html } from './html';
import { renderLayout } from './layout';

/** Reason phrase shown after the status code in the heading and the page title. */
const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  413: 'Payload too large',
  500: 'Server error',
  503: 'Service unavailable',
};

/** Reason phrase for a status the table does not list. */
const FALLBACK_REASON = 'Error';

/**
 * The reason phrase the error page shows after the status code.
 *
 * @param status - The HTTP status of the failure response.
 * @returns `'Bad request'` (400), `'Forbidden'` (403), `'Not found'` (404),
 *   `'Payload too large'` (413), `'Server error'` (500), `'Service unavailable'` (503), or
 *   `'Error'` for any other status.
 */
export function errorReasonPhrase(status: number): string {
  return REASONS[status] ?? FALLBACK_REASON;
}

/**
 * Renders the complete error page for one failure response.
 *
 * Pure and synchronous: the output depends only on `status` and `message`. The layout is rendered
 * with no user, no CSRF token and no scripts, so the page needs no session or database access and
 * renders even while the database is unavailable or before the session middleware has run. This
 * is also what makes the 404 for a missing task byte-identical to the 404 for another user's task.
 *
 * Callers pass one of the fixed public messages ("Bad request.", "Task not found.", "Page not
 * found.", "The form has expired. Reload the page and try again.", "Something went wrong.",
 * "Service temporarily unavailable") and never `err.message`, a stack trace or request data. The
 * message is escaped and rendered exactly as given. Callers set the HTTP status and the
 * `text/html` content type themselves.
 *
 * @param status - The HTTP status, shown in the heading and the title with its reason phrase.
 * @param message - The fixed public message for the failure.
 * @returns The HTML document, starting with `<!doctype html>`.
 */
export function renderErrorPage(status: number, message: string): string {
  const heading = `${status} ${errorReasonPhrase(status)}`;
  const body = html`
      <section class="error-page">
        <h1>${heading}</h1>
        <p>${message}</p>
        <p><a href="/tasks">Go to your tasks</a></p>
      </section>
    `;
  return renderLayout({ title: heading, user: null, csrfToken: '', body });
}

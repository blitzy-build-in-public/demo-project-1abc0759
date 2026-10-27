/**
 * The page behind every failure response: 400, 403, 404, 413, 500 and 503.
 *
 * The page body shows only the status, a fixed reason phrase, the caller's fixed message and a
 * link to `/tasks`. It never receives an error object or request data, so no error property,
 * stack trace or SQL text can reach the browser. The layout's header is rendered for the viewer
 * the caller passes: anonymous by default, or a signed-in user with the response's CSRF token.
 * The page is pure in its status, message and viewer, so two failures with the same status and
 * message produce byte-identical pages for the same viewer (the same user and CSRF token).
 */

import { html } from './html';
import { renderLayout, type LayoutPage } from './layout';

/**
 * Who an error page's header is rendered for, passed through to {@link renderLayout}: `user` is
 * the signed-in user or `null`, and `csrfToken` is the token the header's Log out form carries,
 * used only when `user` is set.
 */
export type ErrorPageViewer = Readonly<Pick<LayoutPage, 'user' | 'csrfToken'>>;

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
 * Pure and synchronous: the output depends only on `status`, `message` and `viewer`, and no
 * session, request or database state is read, so the page renders even while the database is
 * unavailable or before the session middleware has run. The layout is rendered with no scripts.
 * Without a viewer the header shows only the "Task Tracker" title; for a signed-in viewer it adds
 * the navigation, "Signed in as <email>" and the Log out form carrying `viewer.csrfToken`. Two
 * failures with the same status and message are therefore byte-identical for one viewer, which is
 * what makes the 404 for a missing task byte-identical to the 404 for another user's task.
 *
 * Callers pass one of the fixed public messages ("Bad request.", "Task not found.", "Page not
 * found.", "The form has expired. Reload the page and try again.", "Something went wrong.",
 * "Service temporarily unavailable") and never `err.message`, a stack trace or request data. The
 * message is escaped and rendered exactly as given. Callers set the HTTP status and the
 * `text/html` content type themselves.
 *
 * @param status - The HTTP status, shown in the heading and the title with its reason phrase.
 * @param message - The fixed public message for the failure.
 * @param viewer - Who the header is rendered for. Defaults to the anonymous viewer, no user and
 *   no CSRF token. A signed-in viewer must carry the response's session-bound CSRF token, or its
 *   Log out form is refused.
 * @returns The HTML document, starting with `<!doctype html>`.
 */
export function renderErrorPage(
  status: number,
  message: string,
  viewer: ErrorPageViewer = { user: null, csrfToken: '' },
): string {
  const heading = `${status} ${errorReasonPhrase(status)}`;
  const body = html`
      <section class="error-page">
        <h1>${heading}</h1>
        <p>${message}</p>
        <p><a href="/tasks">Go to your tasks</a></p>
      </section>
    `;
  return renderLayout({ title: heading, user: viewer.user, csrfToken: viewer.csrfToken, body });
}

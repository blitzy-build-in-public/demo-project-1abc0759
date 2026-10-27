/**
 * Document shell shared by every page, plus the form-control helpers every template uses.
 *
 * {@link renderLayout} wraps a page body in the HTML document, the stylesheet link, the page's
 * deferred scripts and the site header (navigation, "Signed in as" and the Log out form for a
 * signed-in user). The helpers below give the task form and the reports page one implementation
 * of the CSRF field, inline errors, `aria-describedby` links, and the entered-value fallbacks for
 * selects and date fields after a failed submission, so sibling templates import them from here
 * and never re-implement them.
 *
 * Everything is pure: output depends only on the arguments, so identical inputs give
 * byte-identical pages.
 */

import type { AuthenticatedUser } from '../../auth/auth-service';
import { parseIsoDate } from '../../shared/dates';
import { CSRF_FIELD } from '../csrf';
import { html, type SafeHtml } from './html';

/** A client script under `/static`; the product's only client-side JavaScript. */
export type PageScript = 'completions-chart' | 'confirm-delete';

/** What a page passes to {@link renderLayout}. */
export interface LayoutPage {
  /** Page title, shown before "– Task Tracker" in the browser tab. Escaped. */
  title: string;
  /** The signed-in user, or `null` on the sign-up, login and anonymous error pages. */
  user: AuthenticatedUser | null;
  /** The response's CSRF token, carried by the header's Log out form when `user` is set. */
  csrfToken: string;
  /** The page content, placed inside `<main>`. */
  body: SafeHtml;
  /** Scripts the page needs, loaded with `defer` in this order; duplicates are ignored. */
  scripts?: readonly PageScript[];
}

/**
 * Target of the skip link that opens every page. The link is kept deliberately, beside the
 * header the pages specify, so keyboard users can bypass the header; `app.css` keeps it off-screen
 * until focused. The id is a fragment anchor only, never a styling hook.
 */
const MAIN_ID = 'main';

/**
 * Renders a complete HTML document for one page.
 *
 * The head holds `<meta charset="utf-8">` first, the viewport meta, the title
 * `<page title> – Task Tracker`, the `/static/app.css` link and one deferred
 * `<script src="/static/<name>.js">` per distinct entry in `page.scripts` (none when absent or
 * empty). The body starts with a skip link to `<main>`, then the header with the "Task Tracker"
 * link. Only for a signed-in user does the header add the Tasks and Reports navigation,
 * "Signed in as <email>" and a `POST /logout` form carrying the CSRF field. The user's id and
 * `sessionId` are never rendered.
 *
 * @param page - The page title, user, CSRF token, body and scripts.
 * @returns The document, starting with `<!doctype html>`.
 */
export function renderLayout(page: LayoutPage): string {
  const { title, user, csrfToken, body } = page;
  const scripts = [...new Set(page.scripts ?? [])].map(
    (name) => html`
    <script src="/static/${name}.js" defer></script>`,
  );
  const account =
    user !== null &&
    html`
      <nav aria-label="Main"><a href="/tasks">Tasks</a> <a href="/reports">Reports</a></nav>
      <span class="signed-in">Signed in as ${user.email}</span>
      <form method="post" action="/logout" class="logout-form">
        ${csrfField(csrfToken)}<button type="submit">Log out</button>
      </form>`;
  const markup = html`<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} – Task Tracker</title>
    <link rel="stylesheet" href="/static/app.css">${scripts}
  </head>
  <body>
    <a class="skip-link" href="#${MAIN_ID}">Skip to main content</a>
    <header class="site-header">
      <a href="/tasks" class="site-title">Task Tracker</a>${account}
    </header>
    <main id="${MAIN_ID}">${body}</main>
  </body>
</html>
`;
  return '<!doctype html>\n' + markup.value;
}

/**
 * The hidden CSRF field every `POST` form carries.
 *
 * @param token - The response's CSRF token (`res.locals.csrfToken`).
 * @returns `<input type="hidden" name="_csrf" value="<token>">`, with the token escaped.
 */
export function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;
}

/**
 * An inline validation message for one field, linked from the field through
 * {@link describedBy}. The message is rendered exactly as given (escaped, never reworded).
 *
 * The paragraph carries `role="alert"`, like the login and report messages, so assistive
 * technology announces the message when the re-rendered form loads, not only when its field is
 * reached; the link from the field keeps it in the field's description as well.
 *
 * @param id - Element id the field's `aria-describedby` refers to.
 * @param message - The validation message, or `undefined` (or `''`) when the field is valid.
 * @returns `<p class="field-error" id="<id>" role="alert"><message></p>`, or empty markup when
 *   there is no message.
 */
export function fieldError(id: string, message: string | undefined): SafeHtml {
  if (message === undefined || message === '') {
    return html``;
  }
  return html`<p class="field-error" id="${id}" role="alert">${message}</p>`;
}

/**
 * An `aria-describedby` attribute for use directly inside a start tag, such as
 * `` html`<input id="title"${describedBy('title-hint', error && 'title-error')}>` ``.
 *
 * @param ids - Element ids; `false`, `null`, `undefined` and `''` entries are skipped, so
 *   conditional ids can be passed inline.
 * @returns ` aria-describedby="<ids joined by spaces>"` with a leading space, or empty markup
 *   when no id remains.
 */
export function describedBy(...ids: readonly (string | false | null | undefined)[]): SafeHtml {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  if (present.length === 0) {
    return html``;
  }
  return html` aria-describedby="${present.join(' ')}"`;
}

/** One `<option>` of a select: the submitted value and the visible label. */
export interface SelectOption {
  /** The value submitted with the form. */
  value: string;
  /** The text shown in the list. */
  label: string;
}

/**
 * The `<option>` elements of a select, with `selected` marked.
 *
 * When `selected` matches no option value, which happens only when re-rendering a submission
 * that carried an unknown value, one extra option holding that value is appended, labelled
 * `<value> (invalid)` and marked `selected`, so the entered value stays visible beside its
 * inline error. Callers resolve defaults first: a form maps an absent value to its default, and
 * a filter select includes an "All" option whose value is `''`.
 *
 * @param options - The valid options, in display order.
 * @param selected - The value to mark as selected.
 * @returns The options' markup, all values and labels escaped.
 */
export function selectOptions(options: readonly SelectOption[], selected: string): SafeHtml {
  const rendered = options.map((o) => {
    const mark = o.value === selected && html` selected`;
    return html`<option value="${o.value}"${mark}>${o.label}</option>`;
  });
  const matched = options.some((o) => o.value === selected);
  const invalid =
    !matched && html`<option value="${selected}" selected>${selected} (invalid)</option>`;
  return html`${rendered}${invalid}`;
}

/** Inputs to {@link dateInput}. */
export interface DateInputOptions {
  /** Element id, matched by the field's `<label for>`. */
  id: string;
  /** Form field name. */
  name: string;
  /** The stored value, the default, or the string just submitted. */
  value: string;
  /** Ids passed to {@link describedBy}, such as a hint and the inline error. */
  describedBy?: readonly (string | false | null | undefined)[];
  /** Adds `aria-invalid="true"` when the field failed validation. */
  invalid?: boolean;
  /**
   * Adds `autofocus`, for the first invalid field of a re-rendered form, so the browser scrolls
   * it into view and announces its linked message. At most one field per page may set it.
   */
  autofocus?: boolean;
  /**
   * Whether an empty value is a valid entry (default `true`), as for the optional due date, and
   * so renders as an empty date control. Report range fields pass `false`: a blank there fails
   * `parseIsoDate` like any other invalid date, so it re-renders as the text field.
   */
  emptyIsValid?: boolean;
}

/**
 * A date field that never loses what the user typed.
 *
 * A valid `YYYY-MM-DD` date, or an empty value unless `emptyIsValid` is `false`, renders as
 * `<input type="date">`. Any other value renders as
 * `<input type="text" inputmode="numeric" placeholder="YYYY-MM-DD">` holding the submitted string,
 * because a browser sanitises an invalid value in a `type=date` control to empty. The choice
 * depends on the value alone, never on the `invalid` flag, so a failed date renders as text even
 * when another control of its form is the one flagged invalid. No `required`, `min` or `max` is
 * set: the server is the only validator.
 *
 * @param opts - The field's id, name, value, described-by ids, invalid, autofocus and
 *   empty-is-valid flags.
 * @returns The `<input>` element.
 */
export function dateInput(opts: DateInputOptions): SafeHtml {
  const { id, name, value } = opts;
  const described = describedBy(...(opts.describedBy ?? []));
  const invalid = opts.invalid === true && html` aria-invalid="true"`;
  const autofocus = opts.autofocus === true && html` autofocus`;
  const attrs = html`id="${id}" name="${name}" value="${value}"${described}${invalid}${autofocus}`;
  if (parseIsoDate(value) === null && (value !== '' || opts.emptyIsValid === false)) {
    return html`<input type="text" inputmode="numeric" placeholder="YYYY-MM-DD" ${attrs}>`;
  }
  return html`<input type="date" ${attrs}>`;
}

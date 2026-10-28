/**
 * The sign-up and login pages.
 *
 * Both are anonymous pages rendered through {@link renderLayout} with no user and no scripts.
 * Each form posts with its CSRF field bound to `anon`, carries the sanitised return path in a
 * hidden `next` field, and links to the other page with that same `next`, so a return path
 * survives a detour through sign-up.
 *
 * Password inputs never carry a `value` attribute, including on a re-rendered form, and neither
 * view type has a password field, so a submitted password cannot reach a page. Output depends only
 * on the view model: the login page for an unknown email and for a wrong password differ in nothing
 * the route does not pass, which keeps account existence hidden.
 */

import { AUTH_FIELDS, type AuthFormValues } from '../validation/auth-forms';
import { html } from './html';
import { csrfField, describedBy, fieldError, renderLayout } from './layout';

/** The forms' wire names, taken from the parser that reads them so the markup cannot drift. */
const { email: EMAIL_FIELD, password: PASSWORD_FIELD, next: NEXT_FIELD } = AUTH_FIELDS;

/** View model of the sign-up page (`GET /signup`, and `POST /signup` on 409 or 422). */
export interface SignUpPageView {
  /** The response's CSRF token, bound to `anon`. */
  csrfToken: string;
  /** The entered email (trimmed) and the sanitised return path; `{ email: '', next }` on `GET`. */
  values: AuthFormValues;
  /**
   * Inline messages shown beside their fields, exactly as given: the email policy message or
   * "An account with this email already exists." in `email`, and the password policy message in
   * `password`. Empty on `GET`.
   */
  errors: { email?: string; password?: string };
  /** Optional status notice shown above the form. */
  notice?: string;
}

/** View model of the login page (`GET /login`, and `POST /login` on 422 or 429). */
export interface LogInPageView {
  /** The response's CSRF token, bound to `anon`. */
  csrfToken: string;
  /** The entered email (trimmed) and the sanitised return path; `{ email: '', next }` on `GET`. */
  values: AuthFormValues;
  /** Shows "Your account has been created. Log in to continue." (`GET /login?created=1`). */
  created: boolean;
  /**
   * The page's single message, exactly as the route passes it: "Email or password is incorrect."
   * (422) or "Too many failed attempts. Try again later." (429). Absent on `GET`.
   */
  message?: string;
}

/**
 * Link to `path` carrying the return path. The default `/tasks` is left off, so the plain links
 * stay `/login` and `/signup`. The query value is URL-encoded here; the `html` tag then escapes
 * the `&` and quotes it may contain for the attribute.
 */
function withNext(path: '/login' | '/signup', next: string): string {
  return next === '/tasks' ? path : `${path}?${NEXT_FIELD}=${encodeURIComponent(next)}`;
}

/**
 * Renders the sign-up page: email and password fields with their inline messages, the password
 * policy hint, and a link to log in.
 *
 * The email input keeps the entered value and is marked `aria-invalid` when its message is set;
 * the password input is always empty. No `maxlength` or `pattern` is set, because the server's
 * policy is the only validator and `type="email"` already accepts a superset of its grammar.
 *
 * @param view - The CSRF token, entered values, inline errors and optional notice.
 * @returns The complete HTML document.
 */
export function renderSignUpPage(view: SignUpPageView): string {
  const { values, errors } = view;
  const emailError = errors.email;
  const passwordError = errors.password;
  const notice =
    view.notice &&
    html`
  <p class="notice" role="status">${view.notice}</p>`;
  const emailInvalid = emailError && html` aria-invalid="true"`;
  // aria-invalid on the password too, matching the email field: it is the assistive-technology
  // signal that goes with the inline message, and the stylesheet's non-colour cue.
  const passwordInvalid = passwordError && html` aria-invalid="true"`;

  const body = html`
  <h1>Sign up</h1>${notice}
  <form method="post" action="/signup">
    <label for="email">Email</label>
    <input type="email" id="email" name="${EMAIL_FIELD}" autocomplete="email" required
      value="${values.email}"${describedBy(emailError && 'email-error')}${emailInvalid}>
    ${fieldError('email-error', emailError)}
    <label for="password">Password</label>
    <input type="password" id="password" name="${PASSWORD_FIELD}" autocomplete="new-password"
      required${describedBy('password-hint', passwordError && 'password-error')}${passwordInvalid}>
    <p class="hint" id="password-hint">At least 10 characters, including a letter and a digit.</p>
    ${fieldError('password-error', passwordError)}
    <input type="hidden" name="${NEXT_FIELD}" value="${values.next}">
    ${csrfField(view.csrfToken)}
    <button type="submit">Create account</button>
  </form>
  <p>Already have an account? <a href="${withNext('/login', values.next)}">Log in</a></p>
`;

  return renderLayout({ title: 'Sign up', user: null, csrfToken: view.csrfToken, body });
}

/**
 * Renders the login page: the account-created notice, a single message area above the form, the
 * email and password fields, and a link to sign up that carries the return path.
 *
 * Both inputs point at the message area through `aria-describedby` when a message is set. The
 * markup never varies with the reason a login failed: the route passes one message string, and
 * everything else comes from the entered values and the token.
 *
 * @param view - The CSRF token, entered values, created flag and optional message.
 * @returns The complete HTML document.
 */
export function renderLogInPage(view: LogInPageView): string {
  const { values, message } = view;
  const created =
    view.created &&
    html`
  <p class="notice" role="status">Your account has been created. Log in to continue.</p>`;
  const messageArea =
    message &&
    html`
  <p class="form-error" id="login-error" role="alert">${message}</p>`;
  const described = describedBy(message && 'login-error');

  const body = html`
  <h1>Log in</h1>${created}${messageArea}
  <form method="post" action="/login">
    <label for="email">Email</label>
    <input type="email" id="email" name="${EMAIL_FIELD}" autocomplete="email" required
      value="${values.email}"${described}>
    <label for="password">Password</label>
    <input type="password" id="password" name="${PASSWORD_FIELD}" autocomplete="current-password"
      required${described}>
    <input type="hidden" name="${NEXT_FIELD}" value="${values.next}">
    ${csrfField(view.csrfToken)}
    <button type="submit">Log in</button>
  </form>
  <p>New here? <a href="${withNext('/signup', values.next)}">Sign up</a></p>
`;

  return renderLayout({ title: 'Log in', user: null, csrfToken: view.csrfToken, body });
}

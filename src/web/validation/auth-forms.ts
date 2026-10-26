/**
 * Parsing of the sign-up and login forms.
 *
 * Every function is pure. Fields are read with {@link readField}, so a repeated or non-string
 * field is a malformed request that throws `BadRequestError` (400) before any service call. So
 * is a login email whose lockout key PostgreSQL cannot take: one containing U+0000, or longer
 * than `MAX_LOGIN_KEY_BYTES` (1,024) UTF-8 bytes. The values a page re-renders never include the
 * password: password inputs are always rendered empty, including after a failed submission.
 */

import { normalizeEmail, validateEmail, validatePassword } from '../../auth/password-policy';
import { BadRequestError } from '../../shared/errors';
import { sanitizeReturnPath } from '../return-path';
import { assertStorableText, readField } from './params';
import type { FormResult } from './params';

/**
 * Message for every failed login: an unknown email, a wrong password and a blank field all get
 * exactly this text, so the response never reveals whether an account exists.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'Email or password is incorrect.';

/** Message shown beside the email field when sign-up finds the address already registered. */
export const DUPLICATE_EMAIL_MESSAGE = 'An account with this email already exists.';

/** Message shown when the login lockout refuses an attempt. */
export const LOCKOUT_MESSAGE = 'Too many failed attempts. Try again later.';

/**
 * Largest login lockout key, in UTF-8 bytes. It is far above the 254-character longest address
 * sign-up accepts, so every attempt on an address an account can hold is still checked and
 * counted, and far below PostgreSQL's 2,704-byte B-tree entry limit, so the failure row for
 * `login_attempts_email_failed_idx` can always be inserted.
 */
const MAX_LOGIN_KEY_BYTES = 1_024;

/**
 * What the sign-up and login pages re-render after a submission, and where a login returns to.
 *
 * There is deliberately no password field: password inputs are always rendered empty, so the
 * type itself keeps a submitted password out of every page.
 */
export interface AuthFormValues {
  /** The submitted email, trimmed, or `''` when the field is absent. */
  email: string;
  /** The submitted return path after {@link sanitizeReturnPath}: `/tasks` when absent or unsafe. */
  next: string;
}

/** Credentials ready for the auth service, shaped as the input of its `signUp` and `logIn`. */
export interface AuthCredentials {
  /** The email trimmed, with its case as entered. */
  email: string;
  /** The password exactly as typed, never trimmed. */
  password: string;
}

/**
 * Inline messages of a failed sign-up: one per re-rendered field of {@link AuthFormValues}, plus
 * the password's policy message.
 */
export interface SignUpFormErrors extends Partial<Record<keyof AuthFormValues, string>> {
  /**
   * The password's inline policy message. The password input is always re-rendered empty, so it
   * has no entry in {@link AuthFormValues}.
   */
  password?: string;
}

/**
 * Outcome of {@link parseSignUpForm}. Every value is a
 * `FormResult<AuthCredentials, AuthFormValues>` and is assignable to it, refined so that the
 * failure branch also types the password message as {@link SignUpFormErrors}.
 */
export type SignUpFormResult =
  | Extract<FormResult<AuthCredentials, AuthFormValues>, { ok: true }>
  // The password message has no re-render value to key it, so sign-up refines the shared
  // FormResult's failure branch here instead of widening FormResult's error keys for every form.
  | (Extract<FormResult<AuthCredentials, AuthFormValues>, { ok: false }> & {
      errors: SignUpFormErrors;
    });

/**
 * Reads the entered email and the sanitised return path from a sign-up or login form.
 *
 * Both parsers build their `values` with it. Routes call it when parsing succeeded but the
 * service rejected the attempt (409 duplicate email, 422 invalid credentials, 429 lockout), to
 * re-render with the entered email and `next`, and for the redirect target after a successful
 * login. The success branch of {@link FormResult} carries only `value`, so `next` is exposed
 * through this helper rather than through the parsers' results.
 *
 * @param body - `req.body` of `POST /signup` or `POST /login`.
 * @returns The trimmed email (`''` when absent) and the return path from
 *   {@link sanitizeReturnPath}.
 * @throws `BadRequestError` when `email` or `next` is repeated or not a string.
 */
export function readAuthFormValues(body: unknown): AuthFormValues {
  return {
    email: (readField(body, 'email') ?? '').trim(),
    next: sanitizeReturnPath(readField(body, 'next')),
  };
}

/**
 * Parses the sign-up form: `email`, `password` and `next`.
 *
 * The email is checked with {@link validateEmail} and the untrimmed password with
 * {@link validatePassword}. Both messages are reported together when both fields fail. The auth
 * service's `signUp` checks the same policy functions again before hashing, so this parser exists
 * for the inline messages and no path stores a value the policy rejects.
 *
 * @param body - `req.body` of `POST /signup`.
 * @returns A {@link SignUpFormResult}. On success, the email trimmed with its case as entered
 *   (uniqueness compares `lower(email)`) and the password exactly as typed. On failure,
 *   {@link SignUpFormErrors} with `errors.email` and/or `errors.password` holding the policy
 *   messages, and `values` from {@link readAuthFormValues}, which hold no password.
 * @throws `BadRequestError` when `email`, `password` or `next` is repeated or not a string.
 */
export function parseSignUpForm(body: unknown): SignUpFormResult {
  const values = readAuthFormValues(body);
  const password = readField(body, 'password') ?? '';

  const errors: SignUpFormErrors = {};
  const emailError = validateEmail(values.email);
  if (emailError !== null) {
    errors.email = emailError;
  }
  const passwordError = validatePassword(password);
  if (passwordError !== null) {
    errors.password = passwordError;
  }

  if (errors.email !== undefined || errors.password !== undefined) {
    return { ok: false, errors, values };
  }
  return { ok: true, value: { email: values.email, password } };
}

/**
 * Parses the login form: `email`, `password` and `next`.
 *
 * The email's lockout key is derived with {@link normalizeEmail}, the policy helper the auth
 * service locks on and records failures under, and must be text PostgreSQL can bind and index.
 * A blank email (after trimming) or an empty password fails with
 * {@link INVALID_CREDENTIALS_MESSAGE} in `errors.email`. The route renders it in the login page's
 * single message area with 422 and calls no service, so a blank submission is never recorded as a
 * failed attempt. Every other well-formed submission succeeds here and the auth service decides.
 *
 * @param body - `req.body` of `POST /login`.
 * @returns On success, the email trimmed with its case as entered and the password exactly as
 *   typed. On failure, the generic message and `values` from {@link readAuthFormValues}, which
 *   hold no password.
 * @throws `BadRequestError` when `email`, `password` or `next` is repeated or not a string, or
 *   when the email's lockout key contains U+0000 or is longer than 1,024 UTF-8 bytes.
 */
export function parseLogInForm(body: unknown): FormResult<AuthCredentials, AuthFormValues> {
  const values = readAuthFormValues(body);
  const password = readField(body, 'password') ?? '';

  // The auth service locks on, and records failures under, normalizeEmail(email), so the parser
  // checks that same key. A key holding U+0000, which PostgreSQL text cannot store, or one too
  // long for the login_attempts index is a malformed request (400, no data changed), whatever
  // else is blank.
  // The rejection depends on the submitted text alone, and no account email can contain U+0000
  // or exceed 254 characters, so neither the 400 nor its timing reveals whether an account
  // exists. The password is never checked here: it reaches only bcrypt, never SQL, so a password
  // containing U+0000 is not banned.
  const key = normalizeEmail(values.email);
  assertStorableText(key);
  if (Buffer.byteLength(key, 'utf8') > MAX_LOGIN_KEY_BYTES) {
    throw new BadRequestError();
  }

  // Beyond that key check, login deliberately applies neither the email grammar nor the password
  // policy (nor the 72-byte limit). Every failed login must look identical, so an address that
  // could never be registered gets the same generic answer from the service as a wrong password,
  // and the response reveals nothing about which emails have accounts.
  if (key === '' || password === '') {
    return { ok: false, errors: { email: INVALID_CREDENTIALS_MESSAGE }, values };
  }
  return { ok: true, value: { email: values.email, password } };
}

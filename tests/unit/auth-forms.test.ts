/**
 * Unit tests for the sign-up and login form parsers in `src/web/validation/auth-forms.ts`.
 *
 * A malformed request gets 400 "Bad request." and changes no data, so the login parser throws
 * `BadRequestError` before any service call for a repeated field and for an email whose lockout
 * key PostgreSQL cannot bind or index: one holding U+0000, or longer than 1,024 UTF-8 bytes once
 * trimmed and lower-cased. Every failed login must look identical, so login applies neither the
 * email grammar nor the password policy, and a blank field gets the generic message. Sign-up keeps
 * its inline policy messages, an email holding U+0000 included. No result echoes the password.
 */

import {
  EMAIL_INVALID_MESSAGE,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
} from '../../src/auth/password-policy';
import { BadRequestError } from '../../src/shared/errors';
import {
  INVALID_CREDENTIALS_MESSAGE,
  parseLogInForm,
  parseSignUpForm,
} from '../../src/web/validation/auth-forms';
import type {
  AuthCredentials,
  AuthFormValues,
  SignUpFormErrors,
} from '../../src/web/validation/auth-forms';

/** A submitted form: a label for the test name and the parsed `req.body`. */
interface BodyCase {
  name: string;
  body: unknown;
}

/** A login submission the parser accepts, with the credentials it passes to the service. */
interface LogInSuccessCase extends BodyCase {
  value: AuthCredentials;
}

/** A submission that fails with inline messages, and the values the page re-renders. */
interface FailureCase extends BodyCase {
  errors: SignUpFormErrors;
  values: AuthFormValues;
}

/** Domain of the generated long addresses. */
const DOMAIN = '@example.com';

/** An ASCII login email of exactly `bytes` UTF-8 bytes, lower-cased already. */
function emailOfBytes(bytes: number): string {
  return 'a'.repeat(bytes - DOMAIN.length) + DOMAIN;
}

/** Asserts that `parse` throws the malformed-request error rendered as 400 "Bad request.". */
function expectBadRequest(parse: () => unknown): void {
  let thrown: unknown;
  try {
    parse();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BadRequestError);
  expect(thrown).toMatchObject({ status: 400, publicMessage: 'Bad request.' });
}

describe('parseLogInForm', () => {
  test.each<BodyCase>([
    {
      name: 'an email containing U+0000',
      body: { email: 'alice\u0000@example.com', password: 'Whatever123' },
    },
    {
      // Malformed beats blank: the key check runs before the blank-field check.
      name: 'a U+0000 email with an empty password',
      body: { email: '\u0000', password: '' },
    },
    { name: 'a U+0000 email with no password field', body: { email: '\u0000' } },
    { name: 'a lockout key of 1,025 bytes', body: { email: emailOfBytes(1_025), password: 'x' } },
    {
      // U+0130 (İ) is 2 UTF-8 bytes, so 512 of them are 1,024 bytes as typed; lower-casing turns
      // each into 'i' + U+0307, 3 bytes, so the key the service would lock on is 1,536 bytes.
      name: 'an email whose key grows past 1,024 bytes when lower-cased',
      body: { email: '\u0130'.repeat(512), password: 'x' },
    },
    {
      name: 'a repeated email field',
      body: { email: ['a@b.com', 'c@d.com'], password: 'Whatever123' },
    },
  ])('throws BadRequestError for $name', ({ body }) => {
    expectBadRequest(() => parseLogInForm(body));
  });

  test.each<LogInSuccessCase>([
    {
      name: 'a lockout key of exactly 1,024 bytes',
      body: { email: emailOfBytes(1_024), password: 'Whatever123' },
      value: { email: emailOfBytes(1_024), password: 'Whatever123' },
    },
    {
      name: 'a 1,024-byte key typed in upper case, keeping its case',
      body: { email: emailOfBytes(1_024).toUpperCase(), password: 'Whatever123' },
      value: { email: emailOfBytes(1_024).toUpperCase(), password: 'Whatever123' },
    },
    {
      name: 'a 1,024-byte key wrapped in spaces, trimmed',
      body: { email: `  ${emailOfBytes(1_024)}  `, password: 'Whatever123' },
      value: { email: emailOfBytes(1_024), password: 'Whatever123' },
    },
    {
      // The password reaches only bcrypt, never SQL, so U+0000 in it is not banned.
      name: 'a password containing U+0000, kept exactly',
      body: { email: 'a@b.com', password: 'p\u0000w' },
      value: { email: 'a@b.com', password: 'p\u0000w' },
    },
    {
      name: 'an email outside the sign-up grammar',
      body: { email: ' Not-An-Email ', password: 'x' },
      value: { email: 'Not-An-Email', password: 'x' },
    },
    {
      name: 'a 100-byte password, with no 72-byte rule on login',
      body: { email: 'a@b.com', password: 'p'.repeat(100) },
      value: { email: 'a@b.com', password: 'p'.repeat(100) },
    },
  ])('accepts $name', ({ body, value }) => {
    expect(parseLogInForm(body)).toStrictEqual({ ok: true, value });
  });

  // toStrictEqual pins the whole result, so a `password` key in `values` would fail the test.
  test.each<FailureCase>([
    {
      name: 'a blank email',
      body: { email: '   ', password: 'x' },
      errors: { email: INVALID_CREDENTIALS_MESSAGE },
      values: { email: '', next: '/tasks' },
    },
    {
      name: 'an empty password',
      body: { email: 'a@b.com', password: '' },
      errors: { email: INVALID_CREDENTIALS_MESSAGE },
      values: { email: 'a@b.com', next: '/tasks' },
    },
    {
      name: 'an empty body',
      body: {},
      errors: { email: INVALID_CREDENTIALS_MESSAGE },
      values: { email: '', next: '/tasks' },
    },
  ])('fails $name with the generic message and no password', ({ body, errors, values }) => {
    expect(parseLogInForm(body)).toStrictEqual({ ok: false, errors, values });
  });
});

describe('parseSignUpForm', () => {
  // A throw would fail these tests, so each also shows that sign-up keeps its inline messages.
  test.each<FailureCase>([
    {
      name: 'an email containing U+0000 as an invalid email, without throwing',
      body: { email: 'alice\u0000@example.com', password: 'Passw0rd1234' },
      errors: { email: EMAIL_INVALID_MESSAGE },
      values: { email: 'alice\u0000@example.com', next: '/tasks' },
    },
    {
      name: 'both field messages together',
      body: { email: 'bad', password: 'short' },
      errors: { email: EMAIL_INVALID_MESSAGE, password: PASSWORD_POLICY_MESSAGE },
      values: { email: 'bad', next: '/tasks' },
    },
    {
      name: 'a 73-byte password as too long',
      body: { email: 'alice@example.com', password: 'a1' + 'b'.repeat(71) },
      errors: { password: PASSWORD_TOO_LONG_MESSAGE },
      values: { email: 'alice@example.com', next: '/tasks' },
    },
  ])('reports $name, re-rendering no password', ({ body, errors, values }) => {
    expect(parseSignUpForm(body)).toStrictEqual({ ok: false, errors, values });
  });
});

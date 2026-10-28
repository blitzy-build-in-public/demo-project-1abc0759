/**
 * Unit tests for the account rules in `src/auth/password-policy.ts`: email normalisation (the
 * login-lockout key), the sign-up email grammar with its accepted and rejected addresses, and the
 * password policy including the 72-byte limit that bcrypt imposes. These verify the sign-up
 * states "Enter a valid email address.", "Password must be at least 10 characters and contain a
 * letter and a digit." and "Password is too long (maximum 72 bytes).", and they are the unit-level
 * "Password policy" test item behind success criteria SC1 and SC11.
 *
 * The suite also covers the sign-up and login form parsers in
 * `src/web/validation/auth-forms.ts`. A malformed request gets 400 "Bad request." and changes no
 * data, so the login parser throws `BadRequestError` before any service call for a repeated field
 * and for an email whose lockout key PostgreSQL cannot bind or index: one holding U+0000, or
 * longer than 1,024 UTF-8 bytes once trimmed and lower-cased. Every failed login must look
 * identical, so login applies neither the email grammar nor the password policy, and a blank
 * field gets the generic "Email or password is incorrect." message. Sign-up keeps its inline
 * policy messages, an email holding U+0000 included. No result echoes the password.
 *
 * Assertions compare against the message text itself, not only the exported constants, so a
 * changed constant fails the suite. Every boundary fixture is measured by its own assertion, so
 * a fixture that drifts off its boundary fails instead of silently testing something else.
 * The space-padded password fixtures change result once trimmed, so a policy that trimmed the
 * password would fail the suite.
 */

import {
  EMAIL_INVALID_MESSAGE,
  MAX_DOMAIN_LABEL_CHARS,
  MAX_EMAIL_CHARS,
  MAX_LOCAL_PART_CHARS,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARS,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
  normalizeEmail,
  validateEmail,
  validatePassword,
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

/** The user-facing messages, written out so the suite does not trust the constants. */
const EMAIL_TEXT = 'Enter a valid email address.';
const POLICY_TEXT =
  'Password must be at least 10 characters and contain a letter and a digit.';
const TOO_LONG_TEXT = 'Password is too long (maximum 72 bytes).';
const LOGIN_FAILED_TEXT = 'Email or password is incorrect.';

/** Precomposed U+00E9: one code point, two UTF-8 bytes. */
const E_ACUTE = '\u00e9';

/** U+1D49C MATHEMATICAL SCRIPT CAPITAL A: one letter, two UTF-16 units, four UTF-8 bytes. */
const SCRIPT_A = '\u{1D49C}';

/**
 * An address with a 64-character local part and the domain `b{63}.c{63}.d{n}.com`, whose labels
 * are all within 63 characters. Its total length is `n + 197`.
 */
function addressWithThirdLabel(thirdLabelChars: number): string {
  return (
    'a'.repeat(64) +
    '@' +
    'b'.repeat(63) +
    '.' +
    'c'.repeat(63) +
    '.' +
    'd'.repeat(thirdLabelChars) +
    '.com'
  );
}

/** Exactly 254 characters: the longest address the grammar accepts. */
const LONGEST_EMAIL = addressWithThirdLabel(57);

/** Exactly 255 characters, every part otherwise valid. */
const OVERLONG_EMAIL = addressWithThirdLabel(58);

/** 37 code points in exactly 72 UTF-8 bytes. */
const MAX_BYTES_ACCENTED_PASSWORD = E_ACUTE.repeat(35) + '12';

/** 37 code points in 73 UTF-8 bytes. */
const OVERLONG_ACCENTED_PASSWORD = E_ACUTE.repeat(36) + '1';

/** 10 code points held in 19 UTF-16 units. */
const ASTRAL_TEN_PASSWORD = SCRIPT_A.repeat(9) + '1';

/** 9 code points held in 17 UTF-16 units, so a `.length` check would wrongly accept it. */
const ASTRAL_NINE_PASSWORD = SCRIPT_A.repeat(8) + '1';

/** 10 code points ending in 8 spaces: valid only untrimmed, since trimmed it is `a1`. */
const TRAILING_PADDED_PASSWORD = 'a1' + ' '.repeat(8);

/** 10 code points starting with 8 spaces: valid only untrimmed, since trimmed it is `a1`. */
const LEADING_PADDED_PASSWORD = ' '.repeat(8) + 'a1';

/** 73 UTF-8 bytes with a space at each end: trimmed it is 71 bytes and would be accepted. */
const PADDED_OVERLONG_PASSWORD = ' ' + 'a'.repeat(70) + '1' + ' ';

/** A named input for a table-driven case. */
interface InputCase {
  name: string;
  input: string;
}

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

describe('password-policy constants', () => {
  it.each<{ name: string; actual: string | number; expected: string | number }>([
    { name: 'EMAIL_INVALID_MESSAGE', actual: EMAIL_INVALID_MESSAGE, expected: EMAIL_TEXT },
    { name: 'PASSWORD_POLICY_MESSAGE', actual: PASSWORD_POLICY_MESSAGE, expected: POLICY_TEXT },
    {
      name: 'PASSWORD_TOO_LONG_MESSAGE',
      actual: PASSWORD_TOO_LONG_MESSAGE,
      expected: TOO_LONG_TEXT,
    },
    {
      name: 'INVALID_CREDENTIALS_MESSAGE',
      actual: INVALID_CREDENTIALS_MESSAGE,
      expected: LOGIN_FAILED_TEXT,
    },
    { name: 'MAX_EMAIL_CHARS', actual: MAX_EMAIL_CHARS, expected: 254 },
    { name: 'MAX_LOCAL_PART_CHARS', actual: MAX_LOCAL_PART_CHARS, expected: 64 },
    { name: 'MAX_DOMAIN_LABEL_CHARS', actual: MAX_DOMAIN_LABEL_CHARS, expected: 63 },
    { name: 'MIN_PASSWORD_CHARS', actual: MIN_PASSWORD_CHARS, expected: 10 },
    { name: 'MAX_PASSWORD_BYTES', actual: MAX_PASSWORD_BYTES, expected: 72 },
  ])('$name is $expected', ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });
});

describe('boundary fixtures', () => {
  it('sit exactly on the boundaries they are named for', () => {
    expect(LONGEST_EMAIL).toHaveLength(254);
    expect(OVERLONG_EMAIL).toHaveLength(255);
    expect(Buffer.byteLength(MAX_BYTES_ACCENTED_PASSWORD, 'utf8')).toBe(72);
    expect(Buffer.byteLength(OVERLONG_ACCENTED_PASSWORD, 'utf8')).toBe(73);
    expect(Buffer.byteLength('a'.repeat(71) + '1', 'utf8')).toBe(72);
    expect(Buffer.byteLength('a'.repeat(72) + '1', 'utf8')).toBe(73);
    expect([...ASTRAL_TEN_PASSWORD]).toHaveLength(10);
    expect(ASTRAL_TEN_PASSWORD).toHaveLength(19);
    expect([...ASTRAL_NINE_PASSWORD]).toHaveLength(9);
    expect(ASTRAL_NINE_PASSWORD).toHaveLength(17);
    expect([...TRAILING_PADDED_PASSWORD]).toHaveLength(10);
    expect([...TRAILING_PADDED_PASSWORD.trim()]).toHaveLength(2);
    expect([...LEADING_PADDED_PASSWORD]).toHaveLength(10);
    expect([...LEADING_PADDED_PASSWORD.trim()]).toHaveLength(2);
    expect(Buffer.byteLength(PADDED_OVERLONG_PASSWORD, 'utf8')).toBe(73);
    expect(Buffer.byteLength(PADDED_OVERLONG_PASSWORD.trim(), 'utf8')).toBe(71);
  });
});

describe('normalizeEmail', () => {
  it.each<InputCase & { expected: string }>([
    {
      name: 'surrounding spaces and mixed case',
      input: '  User@Example.COM ',
      expected: 'user@example.com',
    },
    {
      name: 'a tab and a line break',
      input: '\tFirst.Last@Example.IO\n',
      expected: 'first.last@example.io',
    },
    {
      name: 'an already normalised address',
      input: 'user@example.com',
      expected: 'user@example.com',
    },
  ])('trims and lower-cases $name', ({ input, expected }) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('validateEmail', () => {
  it.each<InputCase>([
    { name: 'a plain address', input: 'user@example.com' },
    { name: 'dots, a plus tag and four labels', input: 'first.last+tag@sub.example.co.uk' },
    { name: 'an apostrophe in the local part', input: 'o\'brien@example.ie' },
    { name: 'mixed case, kept as entered', input: 'User@Example.COM' },
    { name: 'surrounding whitespace, trimmed before matching', input: '  user@example.com  ' },
    { name: 'a 64-character local part', input: 'a'.repeat(64) + '@example.com' },
    { name: 'a 254-character address', input: LONGEST_EMAIL },
    { name: 'a 63-character domain label', input: 'a@' + 'b'.repeat(63) + '.com' },
    { name: 'an inner hyphen and digits in a label', input: 'a@b-2c.example.com' },
  ])('accepts $name', ({ input }) => {
    expect(validateEmail(input)).toBeNull();
  });

  it.each<InputCase>([
    { name: 'an empty domain label before the dot', input: 'a@.com' },
    { name: 'two consecutive dots in the domain', input: 'a@b..com' },
    { name: 'a single-label domain', input: 'a@b' },
    { name: 'a one-letter last label', input: 'a@b.c' },
    { name: 'a local part starting with a dot', input: '.a@b.com' },
    { name: 'a local part ending with a dot', input: 'a.@b.com' },
    { name: 'two consecutive dots in the local part', input: 'a..b@c.com' },
    { name: 'a label starting with a hyphen', input: 'a@-b.com' },
    { name: 'a label ending with a hyphen', input: 'a@b-.com' },
    { name: 'inner whitespace', input: 'a b@c.com' },
    { name: 'an empty local part', input: '@b.com' },
    { name: 'two @ signs', input: 'a@@b.com' },
    { name: 'a trailing dot', input: 'a@b.com.' },
    { name: 'a 65-character local part', input: 'a'.repeat(65) + '@example.com' },
    { name: 'a 255-character address', input: OVERLONG_EMAIL },
    { name: 'a 64-character domain label', input: 'a@' + 'b'.repeat(64) + '.com' },
    { name: 'a non-ASCII local part', input: '\u00fc@example.com' },
    { name: 'a control character', input: 'a\u0007b@c.com' },
    { name: 'no @ at all', input: 'user.example.com' },
    { name: 'an empty string', input: '' },
    { name: 'whitespace only', input: '   ' },
  ])('rejects $name with the invalid-email message', ({ input }) => {
    expect(validateEmail(input)).toBe(EMAIL_TEXT);
  });
});

describe('validatePassword', () => {
  it.each<InputCase>([
    { name: 'exactly 10 code points', input: 'abcdefghi1' },
    { name: 'non-ASCII letters', input: 'p\u00e4ssw\u00f6rd12' },
    { name: '10 astral code points in 19 UTF-16 units', input: ASTRAL_TEN_PASSWORD },
    { name: 'a non-ASCII decimal digit (U+0663)', input: 'abcdefghi\u0663' },
    { name: 'surrounding spaces, which are kept', input: '  abcdefghi1  ' },
    { name: 'a1 and 8 trailing spaces, kept as 10 code points', input: TRAILING_PADDED_PASSWORD },
    { name: '8 leading spaces and a1, kept as 10 code points', input: LEADING_PADDED_PASSWORD },
    { name: 'exactly 72 UTF-8 bytes of accented letters', input: MAX_BYTES_ACCENTED_PASSWORD },
    { name: 'exactly 72 ASCII bytes', input: 'a'.repeat(71) + '1' },
  ])('accepts $name', ({ input }) => {
    expect(validatePassword(input)).toBeNull();
  });

  it.each<InputCase>([
    { name: '9 code points', input: 'abcdefgh1' },
    { name: '9 astral code points in 17 UTF-16 units', input: ASTRAL_NINE_PASSWORD },
    { name: 'no digit', input: 'abcdefghij' },
    { name: 'no letter', input: '1234567890' },
    { name: 'spaces counted toward length but no letter', input: '1         ' },
    { name: 'an empty string', input: '' },
    { name: '80 digits, the policy checked before the byte limit', input: '1'.repeat(80) },
  ])('rejects $name with the policy message', ({ input }) => {
    expect(validatePassword(input)).toBe(POLICY_TEXT);
  });

  it.each<InputCase>([
    { name: '73 UTF-8 bytes of accented letters', input: OVERLONG_ACCENTED_PASSWORD },
    { name: '73 ASCII bytes', input: 'a'.repeat(72) + '1' },
    {
      name: '73 bytes once its two surrounding spaces are kept and counted',
      input: PADDED_OVERLONG_PASSWORD,
    },
  ])('rejects $name with the too-long message', ({ input }) => {
    expect(validatePassword(input)).toBe(TOO_LONG_TEXT);
  });
});

describe('parseLogInForm', () => {
  it.each<BodyCase>([
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

  it.each<LogInSuccessCase>([
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
  it.each<FailureCase>([
    {
      name: 'a blank email',
      body: { email: '   ', password: 'x' },
      errors: { email: LOGIN_FAILED_TEXT },
      values: { email: '', next: '/tasks' },
    },
    {
      name: 'an empty password',
      body: { email: 'a@b.com', password: '' },
      errors: { email: LOGIN_FAILED_TEXT },
      values: { email: 'a@b.com', next: '/tasks' },
    },
    {
      name: 'an empty body',
      body: {},
      errors: { email: LOGIN_FAILED_TEXT },
      values: { email: '', next: '/tasks' },
    },
  ])('fails $name with the generic message and no password', ({ body, errors, values }) => {
    expect(parseLogInForm(body)).toStrictEqual({ ok: false, errors, values });
  });
});

describe('parseSignUpForm', () => {
  // A throw would fail these tests, so each also shows that sign-up keeps its inline messages.
  it.each<FailureCase>([
    {
      name: 'an email containing U+0000 as an invalid email, without throwing',
      body: { email: 'alice\u0000@example.com', password: 'Passw0rd1234' },
      errors: { email: EMAIL_TEXT },
      values: { email: 'alice\u0000@example.com', next: '/tasks' },
    },
    {
      name: 'both field messages together',
      body: { email: 'bad', password: 'short' },
      errors: { email: EMAIL_TEXT, password: POLICY_TEXT },
      values: { email: 'bad', next: '/tasks' },
    },
    {
      name: 'a 73-byte password as too long',
      body: { email: 'alice@example.com', password: 'a1' + 'b'.repeat(71) },
      errors: { password: TOO_LONG_TEXT },
      values: { email: 'alice@example.com', next: '/tasks' },
    },
  ])('reports $name, re-rendering no password', ({ body, errors, values }) => {
    expect(parseSignUpForm(body)).toStrictEqual({ ok: false, errors, values });
  });
});

/**
 * Unit tests for the account rules in `src/auth/password-policy.ts`: email normalisation (the
 * login-lockout key), the sign-up email grammar with its accepted and rejected addresses, and the
 * password policy including the 72-byte limit that bcrypt imposes. These verify the sign-up
 * states "Enter a valid email address.", "Password must be at least 10 characters and contain a
 * letter and a digit." and "Password is too long (maximum 72 bytes).", and they are the unit-level
 * "Password policy" test item behind success criteria SC1 and SC11.
 *
 * Assertions compare against the message text itself, not only the exported constants, so a
 * changed constant fails the suite. Every boundary fixture is measured by its own assertion, so
 * a fixture that drifts off its boundary fails instead of silently testing something else.
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

/** The user-facing messages, written out so the suite does not trust the constants. */
const EMAIL_TEXT = 'Enter a valid email address.';
const POLICY_TEXT =
  'Password must be at least 10 characters and contain a letter and a digit.';
const TOO_LONG_TEXT = 'Password is too long (maximum 72 bytes).';

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

/** A named input for a table-driven case. */
interface InputCase {
  name: string;
  input: string;
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
    { name: 'an apostrophe in the local part', input: "o'brien@example.ie" },
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
  ])('rejects $name with the too-long message', ({ input }) => {
    expect(validatePassword(input)).toBe(TOO_LONG_TEXT);
  });
});

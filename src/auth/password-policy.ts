/**
 * Email and password rules for accounts.
 *
 * Pure functions with no I/O. The web sign-up validator calls them for inline messages, and the
 * auth service calls them again before hashing, so no path stores a value these rules reject.
 */

/** Maximum length of a whole email address, in characters, measured after trimming. */
export const MAX_EMAIL_CHARS = 254;

/** Maximum length of the local part of an email address (the text before `@`), in characters. */
export const MAX_LOCAL_PART_CHARS = 64;

/** Maximum length of one dot-separated label of an email domain, in characters. */
export const MAX_DOMAIN_LABEL_CHARS = 63;

/** Minimum password length, counted in Unicode code points rather than UTF-16 code units. */
export const MIN_PASSWORD_CHARS = 10;

/** Maximum password length in UTF-8 bytes, the most input bcrypt reads. */
export const MAX_PASSWORD_BYTES = 72;

/** Message shown when an email address fails {@link validateEmail}. */
export const EMAIL_INVALID_MESSAGE = 'Enter a valid email address.';

/** Message shown when a password is too short or lacks a letter or a digit. */
export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 10 characters and contain a letter and a digit.';

/** Message shown when a password exceeds {@link MAX_PASSWORD_BYTES} UTF-8 bytes. */
export const PASSWORD_TOO_LONG_MESSAGE = 'Password is too long (maximum 72 bytes).';

/** Dot-atom local part: ASCII atoms joined by single dots, never starting or ending with one. */
const LOCAL_PART_PATTERN =
  /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;

/** One domain label: ASCII letters, digits and hyphens, not starting or ending with a hyphen. */
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** The last domain label: at least two ASCII letters. */
const TOP_LEVEL_LABEL_PATTERN = /^[A-Za-z]{2,}$/;

/** Any Unicode letter. */
const LETTER_PATTERN = /\p{L}/u;

/** Any Unicode decimal digit. */
const DIGIT_PATTERN = /\p{Nd}/u;

/**
 * Normalises an email address into the account-independent key used for login lockout: the
 * value stored in `login_attempts.email`, passed to `DataAccess.withLoginLock`, and the value the
 * login looks the account up by. Failures are counted per normalised email, whether or not an
 * account exists for it.
 *
 * @param raw - The email as submitted.
 * @returns The email trimmed and lower-cased.
 */
export function normalizeEmail(raw: string): string {
  // Every address that passes validateEmail is ASCII with no inner whitespace, so for registered
  // emails this equals the SQL lower(btrim(email)) that the users_delete_login_attempts trigger
  // uses to remove a deleted user's failure rows.
  return raw.trim().toLowerCase();
}

/**
 * Checks an email address against the sign-up grammar, after trimming surrounding whitespace.
 *
 * The address is ASCII only, at most {@link MAX_EMAIL_CHARS} characters, and has exactly one `@`.
 * The local part is a dot-atom of 1 to {@link MAX_LOCAL_PART_CHARS} characters. The domain has at
 * least two labels of 1 to {@link MAX_DOMAIN_LABEL_CHARS} letters, digits or inner hyphens, and
 * its last label is at least two letters. Case is preserved: uniqueness and lookups compare
 * `lower(email)` in the database.
 *
 * @param raw - The email as submitted.
 * @returns `null` when the address is valid, otherwise {@link EMAIL_INVALID_MESSAGE}.
 */
export function validateEmail(raw: string): string | null {
  const address = raw.trim();
  if (address.length > MAX_EMAIL_CHARS) {
    return EMAIL_INVALID_MESSAGE;
  }
  const [local, domain, ...extra] = address.split('@');
  if (local === undefined || domain === undefined || extra.length > 0) {
    return EMAIL_INVALID_MESSAGE;
  }
  if (!isValidLocalPart(local) || !isValidDomain(domain)) {
    return EMAIL_INVALID_MESSAGE;
  }
  return null;
}

/**
 * Checks a password against the account policy. The password is never trimmed.
 *
 * Rules apply in order and the first failure decides the message: at least
 * {@link MIN_PASSWORD_CHARS} code points including a Unicode letter and a Unicode decimal digit,
 * then at most {@link MAX_PASSWORD_BYTES} UTF-8 bytes.
 *
 * @param raw - The password exactly as submitted.
 * @returns `null` when the password is acceptable, otherwise {@link PASSWORD_POLICY_MESSAGE} or
 *   {@link PASSWORD_TOO_LONG_MESSAGE}.
 */
export function validatePassword(raw: string): string | null {
  const codePoints = [...raw].length;
  if (codePoints < MIN_PASSWORD_CHARS || !LETTER_PATTERN.test(raw) || !DIGIT_PATTERN.test(raw)) {
    return PASSWORD_POLICY_MESSAGE;
  }
  // The byte limit goes beyond the stated policy on purpose: bcrypt silently ignores every byte
  // after the 72nd, so a longer password is rejected rather than truncated, as OWASP advises.
  if (Buffer.byteLength(raw, 'utf8') > MAX_PASSWORD_BYTES) {
    return PASSWORD_TOO_LONG_MESSAGE;
  }
  return null;
}

/** Whether `local` is a dot-atom of 1 to {@link MAX_LOCAL_PART_CHARS} allowed characters. */
function isValidLocalPart(local: string): boolean {
  return local.length <= MAX_LOCAL_PART_CHARS && LOCAL_PART_PATTERN.test(local);
}

/**
 * Whether `domain` has at least two valid labels and ends in an alphabetic top-level label.
 * Empty labels, from a leading, trailing or doubled dot, fail the label pattern.
 */
function isValidDomain(domain: string): boolean {
  const labels = domain.split('.');
  const topLevel = labels.at(-1);
  if (labels.length < 2 || topLevel === undefined || !TOP_LEVEL_LABEL_PATTERN.test(topLevel)) {
    return false;
  }
  return labels.every(
    (label) => label.length <= MAX_DOMAIN_LABEL_CHARS && DOMAIN_LABEL_PATTERN.test(label),
  );
}

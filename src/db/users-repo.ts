/**
 * Account rows in `users`.
 *
 * Uniqueness of the email, ignoring case, is enforced by the database through the unique index
 * `users_email_lower_key ON users (lower(email))`, so two racing sign-ups for the same address
 * cannot both create an account; the losing insert is reported as `'duplicate'`.
 *
 * {@link UsersRepo.findCredentialsByEmail} is the only function in the application that selects
 * `password_hash`. Nothing here logs.
 */

import { query } from './query';
import type { Queryable } from './query';
import type { NewUserRow, UserCredentials, UserId } from './types';

/** Name PostgreSQL reports as `constraint` when the case-insensitive email index is violated. */
const EMAIL_UNIQUE_INDEX = 'users_email_lower_key';

/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const INSERT_USER_SQL =
  'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id';

// lower(email) matches the expression of users_email_lower_key, so the index serves the lookup
// and the unique index guarantees at most one row.
const SELECT_CREDENTIALS_SQL =
  'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)';

/** Row returned by {@link INSERT_USER_SQL}. */
interface InsertedUserRow {
  id: UserId;
}

/** Row returned by {@link SELECT_CREDENTIALS_SQL}, under its column names. */
interface CredentialsRow {
  id: UserId;
  email: string;
  password_hash: string;
}

/** True when `err` is the driver's unique violation of {@link EMAIL_UNIQUE_INDEX}. */
function isDuplicateEmailError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === UNIQUE_VIOLATION &&
    'constraint' in err &&
    err.constraint === EMAIL_UNIQUE_INDEX
  );
}

/** Data access for accounts, bound to the pool or to one transaction's client. */
export interface UsersRepo {
  /**
   * Creates an account.
   *
   * The email is stored as given (trimmed by the caller, case as entered) and `createdAt` comes
   * from the caller's clock, never the database's `now()`.
   *
   * @param row - The new account, carrying the bcrypt hash and never a plain-text password.
   * @returns The new user's id, or `'duplicate'` when an account already exists for the same
   *   email ignoring case.
   * @throws `DatabaseUnavailableError` when the database cannot be reached; any other driver
   *   error, such as a violated length check, unchanged.
   */
  insert(row: NewUserRow): Promise<{ id: UserId } | 'duplicate'>;

  /**
   * Looks up an account's credentials by email, ignoring case.
   *
   * This is the only function that reads the password hash. Only `authService.logIn` may call it,
   * and the returned hash must never reach templates, logs or any shape passed to the web layer.
   *
   * @param email - The normalised email `normalizeEmail` produced, the caller's login lockout
   *   key; compared with `lower(email) = lower($1)`.
   * @returns The id, stored email and bcrypt hash, or `null` when no account has that email.
   * @throws `DatabaseUnavailableError` when the database cannot be reached.
   */
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
}

/**
 * Builds the users repository over `db`.
 *
 * @param db - The pool for standalone statements, or a checked-out client so that the statements
 *   join that client's transaction.
 * @returns The repository.
 */
export function createUsersRepo(db: Queryable): UsersRepo {
  return {
    async insert(row: NewUserRow): Promise<{ id: UserId } | 'duplicate'> {
      let rows: InsertedUserRow[];
      try {
        rows = await query<InsertedUserRow>(db, INSERT_USER_SQL, [
          row.email,
          row.passwordHash,
          row.createdAt,
        ]);
      } catch (err) {
        if (isDuplicateEmailError(err)) {
          return 'duplicate';
        }
        throw err;
      }
      const inserted = rows[0];
      if (inserted === undefined) {
        throw new Error('insert returned no row');
      }
      return { id: inserted.id };
    },

    async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
      const rows = await query<CredentialsRow>(db, SELECT_CREDENTIALS_SQL, [email]);
      const found = rows[0];
      if (found === undefined) {
        return null;
      }
      return { id: found.id, email: found.email, passwordHash: found.password_hash };
    },
  };
}

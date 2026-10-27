/**
 * JSON-lines logger: the only module in the application that writes logs. No other code
 * writes to the console directly; everything that reports an event receives a
 * {@link Logger}.
 *
 * Each call writes exactly one line, `{ time, level, msg, ...fields, err? }`, with `time` in
 * ISO 8601 UTC.
 *
 * Callers must never pass request bodies, headers, cookies, query strings, passwords,
 * password hashes or session tokens. {@link LogFields} admits primitive values only, and an
 * error is reduced to its name, message, code and stack, so driver properties that can carry
 * SQL text or bound values (`detail`, `query`, `parameters`, `cause` and the like) never
 * reach the output.
 *
 * Neither method throws because of its arguments, since both are called from error paths:
 * every read of an error or field is guarded against throwing getters and proxies, values are
 * reduced to strings and finite numbers, and a line that cannot be serialized is replaced by a
 * reduced one.
 *
 * A logger can also be given credentials to redact ({@link LoggerOptions}): the process entry
 * points pass the database user name and password, because PostgreSQL quotes the user name,
 * which can be an email address, in its own messages, for example
 * `password authentication failed for user "…"` (SQLSTATE 28P01). They are replaced by
 * `[redacted]` in a logged error's message and stack, the only parts of a line that carry driver
 * text, before the line is serialized, so a JSON string escape can never hide one. Each is
 * replaced only where it stands as the credential: a user name in a URL, a quoted role or a
 * `user=` setting, and a password in a URL or a password setting, so the same characters in a
 * file path, a database name or a word stay readable ({@link RedactedCredentials}). Everything
 * else is written as given.
 */

/**
 * Structured fields added to one log line. Values are primitives only, so a request body,
 * headers object, cookie map or query object cannot be passed by type.
 */
export type LogFields = Record<string, string | number | boolean>;

/** Logger with the two levels the application uses. Both methods write synchronously. */
export interface Logger {
  /**
   * Records a routine event: `server listening` (`port`), `migrations applied` (`count`,
   * `versions` comma-joined), `purge completed` (`sessions`, `loginAttempts`) and shutdown.
   */
  info(msg: string, fields?: LogFields): void;

  /**
   * Records a failure: configuration invalid (the message only), `migration failed`,
   * `migration unlock failed`, `idle client error`, `purge failed`, and `database unavailable`
   * or `unexpected error` with `method` and `path` (the path without its query string).
   * `err`, when given, is reduced to its name, message, code and stack; a hostile value
   * (throwing getters, proxies, non-string properties) cannot make this method throw.
   */
  error(msg: string, err?: unknown, fields?: LogFields): void;
}

/** The only error data a log line carries. */
interface SerializedError {
  name?: string;
  message: string;
  code?: string | number;
  stack?: string;
}

/** Entry keys a caller's field can never overwrite. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['time', 'level', 'msg', 'err']);

/** Result of a property read that threw; never written to a line. */
const UNREADABLE: unique symbol = Symbol('unreadable');

/** `err.message` when reading it threw. */
const UNREADABLE_MESSAGE = '[unreadable message]';

/** `msg` of a line whose `msg` could not be serialized. */
const UNSERIALIZABLE_MSG = '[unserializable msg]';

/** Text that stands in for each occurrence of a redacted value. */
const REDACTED = '[redacted]';

/** `err.message` when redacting it failed, so that the unredacted text is never written. */
const UNREDACTABLE_MESSAGE = '[unredactable message]';

/**
 * Database credentials a logger replaces by `[redacted]` in a logged error's `message` and
 * `stack`. Empty strings are ignored, and with none left every line is written exactly as
 * without them.
 */
export interface RedactedCredentials {
  /**
   * Role names, each replaced only where it stands as the credential, so the same characters
   * elsewhere, in a file path, a database name or ordinary words, are kept:
   * - the user-info part of a URL, `//<name>:` or `//<name>@`;
   * - PostgreSQL's quoted role, `user "<name>"` or `role "<name>"`, where the quotes hold
   *   exactly the name;
   * - a `user=<name>` setting, the value optionally in quotes, ending at a quote, whitespace,
   *   `&`, `,`, `;`, `)` or the end of the text.
   */
  userNames?: readonly string[];
  /**
   * Passwords, each replaced only where it stands as the credential, so the same characters
   * elsewhere, in a file path, a module name or ordinary words, are kept (a password `index`
   * leaves `pg-pool/index.js` intact, and a password `password` leaves
   * `client password must be a string` intact):
   * - the user-info part of a URL, between `:` and `@`, as in `//<user>:<password>@`;
   * - the whole value of a password setting, `password=<password>`, `password: <password>`,
   *   `"password":"<password>"` or `PASSWORD '<password>'`, the key in lower, upper or
   *   capitalised case and the value optionally in quotes, ending at a quote, whitespace, `&`,
   *   `,`, `;`, `)`, `}` or the end of the text. The key followed by a space and an unquoted
   *   word, as in `password authentication failed`, is not a setting.
   */
  passwords?: readonly string[];
}

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  /**
   * Credentials to redact from a logged error's `message` and `stack`, such as the database
   * user name and password. Nothing else in a line is redacted: `time`, `level`, `msg`, the
   * fields and the error's `name` and `code` are values the code produces, and rewriting them
   * would corrupt the line whenever a credential equals one of them, such as a user named
   * `error` or a password of `28P01`.
   */
  redact?: RedactedCredentials;
}

/**
 * Runs one property read and returns {@link UNREADABLE} when it throws. A getter, a proxy
 * trap or a revoked proxy can throw from an ordinary-looking read, and a logger called from an
 * error path must not throw itself. Each property is read through its own call, so one hostile
 * property loses only itself.
 */
function tryRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNREADABLE;
  }
}

/** Returns `value` when it is a string, otherwise `undefined`, which drops the key. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Returns `source.code` when `source` is an object whose `code` is a string or a finite
 * number. `NaN` and the infinities are dropped because JSON would print them as `null`.
 */
function readCode(source: unknown): string | number | undefined {
  const code = tryRead(() =>
    typeof source === 'object' && source !== null && 'code' in source ? source.code : undefined,
  );
  return typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))
    ? code
    : undefined;
}

/**
 * Converts a thrown value that is not an `Error` to text. `String()` throws for objects
 * without a prototype, and a logger called from an error path must not throw itself.
 */
function describeNonError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `[unprintable ${typeof value}]`;
  }
}

/**
 * Returns the line's `message`, which is always a string: a string is kept, a read that threw
 * gives a fixed text, and any other value is converted by {@link describeNonError}, so an
 * object, a cycle or a BigInt never reaches the line itself.
 */
function describeMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === UNREADABLE ? UNREADABLE_MESSAGE : describeNonError(value);
}

/**
 * Returns true when `value` is an `Error`. `instanceof` throws for a revoked proxy or a proxy
 * whose `getPrototypeOf` trap throws; such a value is then described as a non-`Error`.
 */
function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Reduces a thrown value to the fields a log may hold. The error's own keys are never
 * enumerated: only `code` is read, falling back to `cause.code` so that a wrapping error such
 * as `DatabaseUnavailableError` reports the driver code (`ECONNREFUSED`, `57P01`). The cause
 * itself is never traversed or serialized. A property that is unreadable or of the wrong type
 * is omitted, except `message`, which {@link describeMessage} always makes a string.
 */
function serializeError(err: unknown): SerializedError {
  if (!isError(err)) {
    return { message: describeNonError(err) };
  }
  return {
    name: asString(tryRead(() => err.name)),
    message: describeMessage(tryRead(() => err.message)),
    code: readCode(err) ?? readCode(tryRead(() => err.cause)),
    stack: asString(tryRead(() => err.stack)),
  };
}

/** Returns `value` escaped, so that a pattern matches it only as literal text. */
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text before a password setting's value: the key in lower, upper or capitalised case, then
 * either `=` or `:` with optional quotes and spaces around them (`password=`, `password: `,
 * `"password":"`), or spaces and the single quote that opens an SQL string (`PASSWORD '`).
 * Spaces and an unquoted word are not a setting, so `password authentication failed` holds no
 * value, and nor is a double-quoted word, which in SQL names an identifier, never a value.
 */
const PASSWORD_SETTING_PREFIX = `(?:password|PASSWORD|Password)(?:['"]?\\s*[=:]\\s*['"]?|\\s+')`;

/**
 * The patterns of a password standing as the credential: the user-info part of a URL, between
 * `:` and `@`, and the whole value of a password setting (see {@link PASSWORD_SETTING_PREFIX}),
 * ending at a quote, whitespace, `&`, `,`, `;`, `)`, `}` or the end of the text. Only these
 * contexts match, because neither the driver nor PostgreSQL echoes a password anywhere else,
 * while a short or common password is often an ordinary word or file name (`index`, `app`,
 * `password`), and replacing it everywhere would garble every stack path and message holding it.
 */
function passwordPatterns(password: string): string[] {
  const value = escapePattern(password);
  return [
    `(?<=:)${value}(?=@)`,
    `(?<=${PASSWORD_SETTING_PREFIX})${value}(?=['"\\s&,;)}]|$)`,
  ];
}

/**
 * The patterns of a user name standing as the credential: a URL's user-info part, PostgreSQL's
 * quoted role in its English messages, and a `user=` setting. Only these contexts match, because
 * a role name is often an ordinary word that also names the database, a directory or a module
 * (`app`, `tasktracker`), and replacing it everywhere would make paths and names unreadable.
 */
function userNamePatterns(userName: string): string[] {
  const name = escapePattern(userName);
  return [
    `(?<=\\/\\/)${name}(?=[:@])`,
    `(?<=\\b(?:user|role) ")${name}(?=")`,
    `(?<=\\buser=['"]?)${name}(?=['"\\s&,;)]|$)`,
  ];
}

/** Returns the distinct non-empty strings of `values`, which a caller that casts may not hold. */
function distinctValues(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].filter((value) => typeof value === 'string' && value !== '');
}

/**
 * Builds one pattern matching every password and every user name where it stands as the
 * credential (see {@link RedactedCredentials}), or returns `null` when no non-empty value is
 * given. Each value is escaped, so it matches only as literal text. The alternatives are ordered
 * by their value's length, longest first, so a value that contains another is replaced whole
 * rather than in part, and a single pass never matches inside a {@link REDACTED} marker it has
 * just written.
 */
function redactionPattern(credentials: RedactedCredentials): RegExp | null {
  const alternatives: { length: number; source: string }[] = [];
  for (const password of distinctValues(credentials.passwords)) {
    for (const source of passwordPatterns(password)) {
      alternatives.push({ length: password.length, source });
    }
  }
  for (const userName of distinctValues(credentials.userNames)) {
    for (const source of userNamePatterns(userName)) {
      alternatives.push({ length: userName.length, source });
    }
  }
  if (alternatives.length === 0) {
    return null;
  }
  alternatives.sort((a, b) => b.length - a.length);
  return new RegExp(alternatives.map((alternative) => alternative.source).join('|'), 'gu');
}

/**
 * Replaces every match of `pattern` in the error's `message` and `stack`, the only values of a
 * line that carry driver text, in place. A replacement that fails, which only a text near the
 * engine's maximum string length can cause, gives a fixed `message` and drops the `stack`, so an
 * unredacted value is never written and this function never throws.
 */
function redactError(serialized: SerializedError, pattern: RegExp): void {
  try {
    serialized.message = serialized.message.replace(pattern, REDACTED);
  } catch {
    serialized.message = UNREDACTABLE_MESSAGE;
  }
  if (serialized.stack === undefined) {
    return;
  }
  try {
    serialized.stack = serialized.stack.replace(pattern, REDACTED);
  } catch {
    serialized.stack = undefined;
  }
}

/**
 * Starts an entry in its fixed key order and copies the caller's primitive fields into it.
 * The `typeof` check backs the {@link LogFields} type against a caller that casts. A field
 * whose read throws is dropped, and no field is copied when the keys cannot be listed (a
 * proxy whose `ownKeys` trap throws).
 */
function buildEntry(
  level: 'info' | 'error',
  msg: string,
  fields: LogFields | undefined,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  if (typeof fields !== 'object' || fields === null) {
    return entry;
  }
  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch {
    return entry;
  }
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }
    const value = tryRead(() => fields[key]);
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      entry[key] = value;
    }
  }
  return entry;
}

/**
 * Serializes an entry to its JSON text without throwing. The fields are already primitives
 * and `err` is already reduced to strings and numbers, so only a caller that casts a
 * non-string `msg` (a cycle, a BigInt, a throwing `toJSON`) normally makes the first attempt
 * fail. The second attempt keeps `time`, `level`, a string `msg` and `err`; the last, reached
 * only by output longer than the engine's maximum string length, keeps `time` and `level`
 * with a fixed `msg`.
 */
function serializeEntry(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry);
  } catch {
    const { time, level, msg, err } = entry;
    try {
      return JSON.stringify({
        time,
        level,
        msg: typeof msg === 'string' ? msg : UNSERIALIZABLE_MSG,
        err,
      });
    } catch {
      return JSON.stringify({ time, level, msg: UNSERIALIZABLE_MSG });
    }
  }
}

/**
 * Creates a logger that writes one JSON line per call to `out`.
 *
 * @param out Destination stream; defaults to the process's standard output.
 * @param options Credentials to redact from logged errors' message and stack; none by default.
 * @returns A {@link Logger} whose methods write synchronously and never buffer or filter.
 */
export function createLogger(
  out: NodeJS.WritableStream = process.stdout,
  options: LoggerOptions = {},
): Logger {
  // Built once, so every line is redacted by the same pattern; `null` leaves lines unchanged.
  const pattern = redactionPattern(options.redact ?? {});
  // Serialization is guarded; `out.write` is not, so stream failures surface as the stream
  // reports them.
  const writeLine = (entry: Record<string, unknown>): void => {
    out.write(`${serializeEntry(entry)}\n`);
  };

  return {
    info(msg: string, fields?: LogFields): void {
      writeLine(buildEntry('info', msg, fields));
    },
    error(msg: string, err?: unknown, fields?: LogFields): void {
      const entry = buildEntry('error', msg, fields);
      if (err !== undefined) {
        const serialized = serializeError(err);
        if (pattern !== null) {
          redactError(serialized, pattern);
        }
        entry.err = serialized;
      }
      writeLine(entry);
    },
  };
}

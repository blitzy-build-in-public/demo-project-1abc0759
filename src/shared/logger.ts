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
 * @returns A {@link Logger} whose methods write synchronously and never buffer or filter.
 */
export function createLogger(out: NodeJS.WritableStream = process.stdout): Logger {
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
        entry.err = serializeError(err);
      }
      writeLine(entry);
    },
  };
}

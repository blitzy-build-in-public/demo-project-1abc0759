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
   * `err`, when given, is reduced to its name, message, code and stack.
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

/** Returns `source.code` when `source` is an object whose `code` is a string or number. */
function readCode(source: unknown): string | number | undefined {
  if (typeof source !== 'object' || source === null || !('code' in source)) {
    return undefined;
  }
  const { code } = source;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
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
 * Reduces a thrown value to the fields a log may hold. The error's own keys are never
 * enumerated: only `code` is read, falling back to `cause.code` so that a wrapping error such
 * as `DatabaseUnavailableError` reports the driver code (`ECONNREFUSED`, `57P01`).
 */
function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) {
    return { message: describeNonError(err) };
  }
  return {
    name: err.name,
    message: err.message,
    code: readCode(err) ?? readCode(err.cause),
    stack: err.stack,
  };
}

/**
 * Starts an entry in its fixed key order and copies the caller's primitive fields into it.
 * The `typeof` check backs the {@link LogFields} type against a caller that casts.
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
  for (const [key, value] of Object.entries(fields)) {
    const kind = typeof value;
    if (!RESERVED_KEYS.has(key) && (kind === 'string' || kind === 'number' || kind === 'boolean')) {
      entry[key] = value;
    }
  }
  return entry;
}

/**
 * Creates a logger that writes one JSON line per call to `out`.
 *
 * @param out Destination stream; defaults to the process's standard output.
 * @returns A {@link Logger} whose methods write synchronously and never buffer or filter.
 */
export function createLogger(out: NodeJS.WritableStream = process.stdout): Logger {
  const writeLine = (entry: Record<string, unknown>): void => {
    out.write(`${JSON.stringify(entry)}\n`);
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

import { Writable } from 'node:stream';

import { createLogger } from '../../src/shared/logger';
import type { Logger, LogFields } from '../../src/shared/logger';

/**
 * One parsed log line: the fixed `level` and `msg` keys plus whatever else the production
 * logger wrote (`time`, the caller's fields, and `err` as `{ name, message, code, stack }`).
 */
export interface CapturedEntry {
  level: string;
  msg: string;
  [k: string]: unknown;
}

/** Returns true when `value` is a JSON object whose `level` and `msg` are strings. */
function isCapturedEntry(value: unknown): value is CapturedEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'level' in value &&
    typeof value.level === 'string' &&
    'msg' in value &&
    typeof value.msg === 'string'
  );
}

/**
 * A {@link Logger} for tests that records exactly what production would print.
 *
 * It delegates every call to the real `createLogger` from `src/shared/logger.ts`, writing into
 * an in-memory stream, so the captured text is the production serialisation byte for byte,
 * including the reduced `err` object. Scans for passwords, hashes or session tokens therefore
 * cover the real output rather than a re-implementation of it.
 *
 * Capture is synchronous: the stream's write callback completes immediately, so Node invokes
 * the next write at once instead of buffering it, and every line is recorded before `info` or
 * `error` returns. A test can read {@link CaptureLogger.entries} as soon as a request finishes.
 *
 * One class serves both the in-process app (`startTestApp`) and the test pools
 * (`createTestPool`). It writes nothing to standard output or standard error.
 */
export class CaptureLogger implements Logger {
  private readonly chunks: string[] = [];

  private readonly inner: Logger;

  /** Creates an empty capture backed by the production logger. */
  constructor() {
    // `this` inside a Writable's write option is the stream, so the buffer is captured here.
    const chunks = this.chunks;
    const sink = new Writable({
      write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        callback();
      },
    });
    this.inner = createLogger(sink);
  }

  /**
   * Records a routine event through the production logger.
   *
   * @param msg The event name, for example `purge completed`.
   * @param fields Primitive fields added to the line.
   */
  info(msg: string, fields?: LogFields): void {
    this.inner.info(msg, fields);
  }

  /**
   * Records a failure through the production logger, which reduces `err` to its name,
   * message, code and stack.
   *
   * @param msg The event name, for example `database unavailable`.
   * @param err The thrown value, if any.
   * @param fields Primitive fields added to the line, such as `method` and `path`.
   */
  error(msg: string, err?: unknown, fields?: LogFields): void {
    this.inner.error(msg, err, fields);
  }

  /**
   * Returns the raw output captured so far: one JSON line per call, each ending in `\n`.
   *
   * @returns Exactly the bytes production would have written, as text.
   */
  text(): string {
    return this.chunks.join('');
  }

  /**
   * Parses the captured output into entries, in the order they were written.
   *
   * @returns One entry per non-empty line.
   * @throws Error `CaptureLogger: malformed log line` when a line is not a JSON object with
   *   string `level` and `msg`. The line itself is never included, because it may hold the
   *   very data a test is checking the logs for.
   */
  entries(): CapturedEntry[] {
    return this.text()
      .split('\n')
      .filter((line) => line !== '')
      .map((line): CapturedEntry => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // JSON.parse's own message quotes the input, so it is replaced rather than chained.
          throw new Error('CaptureLogger: malformed log line');
        }
        if (!isCapturedEntry(parsed)) {
          throw new Error('CaptureLogger: malformed log line');
        }
        return parsed;
      });
  }

  /**
   * Returns the entries whose `msg` equals `msg`, in the order they were written.
   *
   * @param msg The exact event name, for example `purge failed`.
   * @returns The matching entries; empty when none match.
   */
  byMsg(msg: string): CapturedEntry[] {
    return this.entries().filter((entry) => entry.msg === msg);
  }

  /** Discards everything captured so far, so `text()` is empty and `entries()` is `[]`. */
  clear(): void {
    this.chunks.length = 0;
  }
}

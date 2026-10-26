import { Writable } from 'node:stream';

import { DatabaseUnavailableError } from '../../src/shared/errors';
import { createLogger } from '../../src/shared/logger';
import type { LogFields, Logger } from '../../src/shared/logger';

/** Clock reading during every test, so whole lines can be compared byte for byte. */
const NOW = '2026-01-02T03:04:05.678Z';

/** The only keys a serialized error may carry. */
const ERR_KEYS: readonly string[] = ['name', 'message', 'code', 'stack'];

/** A logger writing into memory, and the text it has written so far. */
interface Capture {
  logger: Logger;
  text(): string;
}

/** Creates a logger over a synchronous in-memory stream. */
function capture(): Capture {
  const chunks: string[] = [];
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
  return { logger: createLogger(sink), text: () => chunks.join('') };
}

/** Asserts that `text` is exactly one newline-terminated line and returns it parsed. */
function parseOnlyLine(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('');
  const parsed: unknown = JSON.parse(lines[0] ?? '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('log line is not a JSON object');
  }
  return { ...parsed };
}

/** Throws from a getter or a proxy trap. */
function hostile(): never {
  throw new Error('hostile read');
}

/** Returns a plain object that contains itself, which `JSON.stringify` rejects. */
function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

/** Returns `new Error('original failure')` with its `key` property redefined. */
function errorWith(key: string, descriptor: PropertyDescriptor, cause?: unknown): Error {
  const err =
    cause === undefined
      ? new Error('original failure')
      : new Error('original failure', { cause });
  Object.defineProperty(err, key, { configurable: true, ...descriptor });
  return err;
}

/** Returns an `Error` proxy that is already revoked, so every operation on it throws. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable(new Error('original failure'), {});
  revoke();
  return proxy;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(NOW) });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('createLogger error()', () => {
  test.each<[string, () => unknown, Record<string, unknown>]>([
    [
      'throwing code getter',
      () => errorWith('code', { get: hostile }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'throwing code getter, readable cause.code',
      () => errorWith('code', { get: hostile }, { code: 'ECONNREFUSED' }),
      {
        name: 'Error',
        message: 'original failure',
        code: 'ECONNREFUSED',
        stack: expect.any(String),
      },
    ],
    [
      'throwing cause getter',
      () => errorWith('cause', { get: hostile }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'throwing cause.code getter',
      () =>
        new Error('original failure', {
          cause: Object.defineProperty({}, 'code', { get: hostile }),
        }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'proxy whose has trap throws',
      () => new Proxy(new Error('original failure'), { has: hostile }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'proxy whose get trap throws',
      () => new Proxy(new Error('original failure'), { get: hostile }),
      { message: '[unreadable message]' },
    ],
    [
      'proxy whose getPrototypeOf trap throws',
      () => new Proxy(new Error('original failure'), { getPrototypeOf: hostile }),
      { message: 'Error: original failure' },
    ],
    ['revoked proxy', revokedProxy, { message: '[unprintable object]' }],
    [
      'number name',
      () => errorWith('name', { value: 42 }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    [
      'cyclic name',
      () => errorWith('name', { value: cyclic() }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    [
      'BigInt name',
      () => errorWith('name', { value: 10n }),
      { message: 'original failure', stack: expect.any(String) },
    ],
    // V8 formats `stack` on its first read from `name` and `message`. Where either throws when
    // read or converted to text (here and in two `message` rows below), so does reading
    // `stack`, and it is omitted as well.
    [
      'throwing name getter',
      () => errorWith('name', { get: hostile }),
      { message: 'original failure' },
    ],
    [
      'cyclic message',
      () => errorWith('message', { value: cyclic() }),
      { name: 'Error', message: '[object Object]', stack: expect.any(String) },
    ],
    [
      'BigInt message',
      () => errorWith('message', { value: 10n }),
      { name: 'Error', message: '10', stack: expect.any(String) },
    ],
    [
      'prototype-less object message',
      () => errorWith('message', { value: Object.create(null) }),
      { name: 'Error', message: '[unprintable object]' },
    ],
    [
      'throwing message getter',
      () => errorWith('message', { get: hostile }),
      { name: 'Error', message: '[unreadable message]' },
    ],
    [
      'cyclic stack',
      () => errorWith('stack', { value: cyclic() }),
      { name: 'Error', message: 'original failure' },
    ],
    [
      'throwing stack getter',
      () => errorWith('stack', { get: hostile }),
      { name: 'Error', message: 'original failure' },
    ],
    [
      'BigInt code',
      () => errorWith('code', { value: 10n }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'NaN code',
      () => errorWith('code', { value: Number.NaN }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
    [
      'Infinity code, readable cause.code',
      () => errorWith('code', { value: Number.POSITIVE_INFINITY }, { code: '57P01' }),
      { name: 'Error', message: 'original failure', code: '57P01', stack: expect.any(String) },
    ],
    [
      'cyclic cause',
      () => errorWith('cause', { value: cyclic() }),
      { name: 'Error', message: 'original failure', stack: expect.any(String) },
    ],
  ])('reduces an error with a %s to primitives in one line', (_label, makeErr, expected) => {
    const { logger, text } = capture();
    const err = makeErr();

    expect(() => logger.error('failure', err)).not.toThrow();

    const entry = parseOnlyLine(text());
    expect(Object.keys(entry)).toEqual(['time', 'level', 'msg', 'err']);
    const reduced = entry.err;
    if (typeof reduced !== 'object' || reduced === null || Array.isArray(reduced)) {
      throw new Error('err is not a JSON object');
    }
    const reducedEntries: [string, unknown][] = Object.entries(reduced);
    for (const [key, value] of reducedEntries) {
      expect(ERR_KEYS).toContain(key);
      expect(
        typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
      ).toBe(true);
    }
    expect(reduced).toEqual(expected);
  });

  test.each<[string, unknown]>([
    ['cyclic object', cyclic()],
    ['BigInt', 10n],
    ['object whose toJSON throws', { toJSON: hostile }],
  ])('replaces a cast %s msg that cannot be serialized', (_label, msg) => {
    const { logger, text } = capture();
    const err = errorWith('stack', { value: 'Error: original failure\n    at handler' });

    expect(() => logger.error(msg as string, err, { method: 'GET' })).not.toThrow();

    // Only the guaranteed primitives survive: the caller's fields are dropped with the msg.
    expect(text()).toBe(
      `${JSON.stringify({
        time: NOW,
        level: 'error',
        msg: '[unserializable msg]',
        err: {
          name: 'Error',
          message: 'original failure',
          stack: 'Error: original failure\n    at handler',
        },
      })}\n`,
    );
  });

  test('writes time, level and a fixed msg when the reduced line cannot be serialized', () => {
    const { logger, text } = capture();
    // Stands in for output longer than the engine's maximum string length.
    jest
      .spyOn(JSON, 'stringify')
      .mockImplementationOnce(() => {
        throw new RangeError('Invalid string length');
      })
      .mockImplementationOnce(() => {
        throw new RangeError('Invalid string length');
      });

    expect(() => logger.error('migration failed', new Error('original failure'))).not.toThrow();

    expect(text()).toBe(`{"time":"${NOW}","level":"error","msg":"[unserializable msg]"}\n`);
  });
});

describe('createLogger fields', () => {
  test.each<[string, () => unknown, string]>([
    [
      'a throwing getter drops that field only',
      () => Object.defineProperty({ method: 'GET' }, 'path', { enumerable: true, get: hostile }),
      `{"time":"${NOW}","level":"info","msg":"event","method":"GET"}\n`,
    ],
    [
      'a proxy whose ownKeys trap throws drops every field',
      () => new Proxy({ method: 'GET' }, { ownKeys: hostile }),
      `{"time":"${NOW}","level":"info","msg":"event"}\n`,
    ],
    [
      'a proxy whose get trap throws drops every field',
      () => new Proxy({ method: 'GET', path: '/tasks' }, { get: hostile }),
      `{"time":"${NOW}","level":"info","msg":"event"}\n`,
    ],
    [
      'a revoked proxy drops every field',
      revokedProxy,
      `{"time":"${NOW}","level":"info","msg":"event"}\n`,
    ],
  ])('%s', (_label, makeFields, expected) => {
    const { logger, text } = capture();
    const fields = makeFields() as LogFields;

    expect(() => logger.info('event', fields)).not.toThrow();

    expect(text()).toBe(expected);
  });
});

describe('createLogger ordinary inputs', () => {
  /** A pg driver error: its `detail` and `query` carry row values and SQL text. */
  function driverError(message: string, code: string): Error {
    return Object.assign(new Error(message), {
      code,
      detail: 'Key (lower(email))=(alice@example.com) already exists.',
      query: 'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      stack: `Error: ${message}\n    at driver`,
    });
  }

  /** `DatabaseUnavailableError` wrapping a driver error, as the query helper builds it. */
  function unavailable(): Error {
    const err = new DatabaseUnavailableError('Database unavailable', {
      cause: driverError('connect ECONNREFUSED 127.0.0.1:5432', 'ECONNREFUSED'),
    });
    err.stack = 'DatabaseUnavailableError: Database unavailable\n    at query';
    return err;
  }

  test.each<[string, (logger: Logger) => void, Record<string, unknown>]>([
    [
      'info with fields',
      (logger) => logger.info('server listening', { port: 3000 }),
      { time: NOW, level: 'info', msg: 'server listening', port: 3000 },
    ],
    [
      'error without err',
      (logger) => logger.error('configuration invalid'),
      { time: NOW, level: 'error', msg: 'configuration invalid' },
    ],
    [
      'DatabaseUnavailableError reporting cause.code, with request fields',
      (logger) =>
        logger.error('database unavailable', unavailable(), { method: 'GET', path: '/tasks' }),
      {
        time: NOW,
        level: 'error',
        msg: 'database unavailable',
        method: 'GET',
        path: '/tasks',
        err: {
          name: 'DatabaseUnavailableError',
          message: 'Database unavailable',
          code: 'ECONNREFUSED',
          stack: 'DatabaseUnavailableError: Database unavailable\n    at query',
        },
      },
    ],
    [
      'driver error with its own code',
      (logger) =>
        logger.error(
          'unexpected error',
          driverError('duplicate key value violates unique constraint', '23505'),
        ),
      {
        time: NOW,
        level: 'error',
        msg: 'unexpected error',
        err: {
          name: 'Error',
          message: 'duplicate key value violates unique constraint',
          code: '23505',
          stack: 'Error: duplicate key value violates unique constraint\n    at driver',
        },
      },
    ],
    [
      'thrown non-Error value',
      (logger) => logger.error('purge failed', 'socket closed'),
      { time: NOW, level: 'error', msg: 'purge failed', err: { message: 'socket closed' } },
    ],
    [
      'reserved field names',
      (logger) =>
        logger.error('purge failed', undefined, {
          time: 'forged',
          level: 'forged',
          msg: 'forged',
          err: 'forged',
          method: 'POST',
        }),
      { time: NOW, level: 'error', msg: 'purge failed', method: 'POST' },
    ],
  ])('writes %s exactly as before', (_label, call, expected) => {
    const { logger, text } = capture();

    call(logger);

    // `expected` lists the keys in the logger's fixed order, so this compares bytes and order.
    expect(text()).toBe(`${JSON.stringify(expected)}\n`);
  });
});

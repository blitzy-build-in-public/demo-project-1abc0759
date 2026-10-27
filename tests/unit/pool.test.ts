import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createPool } from '../../src/db/pool';
import { CaptureLogger } from '../helpers/capture-logger';

/**
 * How the fake server answers a start-up packet: `scram` asks for SCRAM-SHA-256 and answers the
 * client's first SASL message, so a client without a password fails on its own side; `trust`
 * accepts the client at once.
 */
type Handshake = 'scram' | 'trust';

/** One connection the fake server accepted, seen from the server side. */
interface FakeConnection {
  /** Frontend messages in arrival order: `startup`, then each message's type byte. */
  readonly received: string[];
  /** Resolves once the server-side socket has closed, with whether it closed on an error. */
  readonly closed: Promise<{ hadError: boolean }>;
  /** Whether the server-side socket has closed. */
  isClosed(): boolean;
}

/** How long a closed socket may take to reach the server before the test fails. */
const PROMPT_CLOSE_MS = 1_000;

/** How long an open socket is watched to confirm that nothing closes it. */
const STAYS_OPEN_MS = 200;

/** How long to wait after a close for any `error` event it could have caused. */
const SETTLE_MS = 50;

/** pg's message when SCRAM authentication starts with no password to use. */
const NO_PASSWORD_ERROR = 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string';

/** A big-endian 32-bit integer, the width of every length and code in the protocol. */
function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

/** A backend message: its type byte, its length including itself, and its body. */
function backendMessage(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(type, 'latin1'), int32(body.length + 4), body]);
}

/** AuthenticationSASL offering SCRAM-SHA-256, the request a SCRAM server sends first. */
const AUTHENTICATION_SASL = backendMessage(
  'R',
  Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0', 'latin1')]),
);

/** AuthenticationSASLContinue carrying a server-first message. */
const AUTHENTICATION_SASL_CONTINUE = backendMessage(
  'R',
  Buffer.concat([int32(11), Buffer.from('r=fakenonce,s=c2FsdA==,i=4096', 'latin1')]),
);

/** AuthenticationOk followed by ReadyForQuery (idle), which completes a connection. */
const AUTHENTICATED_AND_READY = Buffer.concat([
  backendMessage('R', int32(0)),
  backendMessage('Z', Buffer.from('I', 'latin1')),
]);

/** Serves one accepted socket with the protocol subset `handshake` needs. */
function serveConnection(socket: Socket, handshake: Handshake): FakeConnection {
  const received: string[] = [];
  let isClosed = false;
  const closed = new Promise<{ hadError: boolean }>((resolve) => {
    socket.once('close', (hadError: boolean): void => {
      isClosed = true;
      resolve({ hadError });
    });
  });
  // A reset from the client is recorded, so the tests' `received` and `hadError` checks fail on
  // it rather than the run failing on an unhandled `error` event.
  socket.on('error', (err: Error): void => {
    received.push(`socket error ${err.message}`);
  });

  let pending = Buffer.alloc(0);
  let typed = false;
  socket.on('data', (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      // The start-up packet has no type byte; every later frontend message starts with one.
      const headerLength = typed ? 5 : 4;
      if (pending.length < headerLength) {
        return;
      }
      const messageLength = typed ? pending.readInt32BE(1) + 1 : pending.readInt32BE(0);
      if (pending.length < messageLength) {
        return;
      }
      const type = typed ? pending.toString('latin1', 0, 1) : 'startup';
      pending = pending.subarray(messageLength);
      typed = true;
      received.push(type);

      if (type === 'startup') {
        socket.write(handshake === 'scram' ? AUTHENTICATION_SASL : AUTHENTICATED_AND_READY);
      } else if (type === 'p' && handshake === 'scram') {
        socket.write(AUTHENTICATION_SASL_CONTINUE);
      }
    }
  });

  return { received, closed, isClosed: (): boolean => isClosed };
}

/** A minimal PostgreSQL server on 127.0.0.1 that records what each connection receives. */
class FakePgServer {
  private readonly connections: FakeConnection[] = [];

  private readonly sockets = new Set<Socket>();

  private readonly server: Server;

  /** Creates a server that answers every connection with `handshake`; call `listen` next. */
  constructor(handshake: Handshake) {
    this.server = createServer((socket: Socket): void => {
      this.sockets.add(socket);
      socket.once('close', (): void => {
        this.sockets.delete(socket);
      });
      this.connections.push(serveConnection(socket, handshake));
    });
  }

  /** Listens on an ephemeral port and resolves with it. */
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', (): void => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address: AddressInfo | string | null = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake server is not listening on a TCP port');
    }
    return address.port;
  }

  /** The single connection accepted so far; throws unless exactly one was accepted. */
  onlyConnection(): FakeConnection {
    const [connection, ...others] = this.connections;
    if (connection === undefined || others.length > 0) {
      throw new Error(`fake server accepted ${this.connections.length} connections, not 1`);
    }
    return connection;
  }

  /** Destroys every open socket and stops listening. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((err?: Error): void => (err === undefined ? resolve() : reject(err)));
    });
  }
}

/** Resolves with `promise`'s value, or rejects once `ms` milliseconds pass first. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout((): void => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('createPool connection teardown', () => {
  const originalEnv = process.env;
  let servers: FakePgServer[];

  /** Starts a fake server for this test and returns a password-less URL for it. */
  async function fakeServerUrl(handshake: Handshake): Promise<[FakePgServer, string]> {
    const server = new FakePgServer(handshake);
    servers.push(server);
    const port = await server.listen();
    return [server, `postgres://alice@127.0.0.1:${port}/db`];
  }

  beforeEach(() => {
    servers = [];
    // The URL carries no password, so none may come from the environment either: pg falls back
    // to PGPASSWORD, then to the pgpass file, which here is a path that does not exist. SSL
    // stays off so the start-up packet is the first thing the fake server reads.
    process.env = {
      ...originalEnv,
      PGPASSFILE: path.join(tmpdir(), `pool-test-no-pgpass-${randomUUID()}`),
    };
    delete process.env.PGPASSWORD;
    delete process.env.PGSSLMODE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await Promise.all(servers.map((server) => server.close()));
  });

  test('a connection pg rejects itself closes its socket at once and logs nothing', async () => {
    const [server, url] = await fakeServerUrl('scram');
    const logger = new CaptureLogger();
    const pool = createPool(url, logger);

    await expect(pool.connect()).rejects.toThrow(NO_PASSWORD_ERROR);

    const connection = server.onlyConnection();
    // Without the teardown the socket would stay open until the server's authentication timeout.
    await expect(within(connection.closed, PROMPT_CLOSE_MS, 'socket close')).resolves.toEqual({
      hadError: false,
    });
    // A plain end of file: no Terminate message was sent in the middle of authentication.
    expect(connection.received).toEqual(['startup', 'p']);

    await delay(SETTLE_MS);
    await expect(pool.end()).resolves.toBeUndefined();
    expect(logger.entries()).toEqual([]);
  });

  test('a connected client keeps its socket, also after a refused second connect', async () => {
    const [server, url] = await fakeServerUrl('trust');
    const logger = new CaptureLogger();
    const pool = createPool(url, logger);

    const client = await pool.connect();
    const connection = server.onlyConnection();
    await delay(STAYS_OPEN_MS);
    expect(connection.isClosed()).toBe(false);

    // pg refuses to reuse a client; that refusal must not close the live socket.
    await expect(client.connect()).rejects.toThrow('Client has already been connected');
    await delay(STAYS_OPEN_MS);
    expect(connection.isClosed()).toBe(false);

    client.release();
    await delay(STAYS_OPEN_MS);
    expect(connection.isClosed()).toBe(false);

    await pool.end();
    await expect(within(connection.closed, PROMPT_CLOSE_MS, 'socket close')).resolves.toEqual({
      hadError: false,
    });
    expect(connection.received).toEqual(['startup', 'X']);
    expect(logger.entries()).toEqual([]);
  });
});

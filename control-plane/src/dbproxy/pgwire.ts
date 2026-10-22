/**
 * The few pieces of the Postgres wire protocol (v3) the database proxy speaks itself: framing,
 * the client's startup packet, ErrorResponse, and the login to the real database (TLS, then
 * SCRAM-SHA-256, cleartext or MD5 as the server asks). Everything after the login is passed
 * through as bytes, apart from the frontend messages that carry SQL (dbproxy/session.ts).
 */
import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { promisify } from 'node:util';

export const SSL_REQUEST = 80877103;
export const GSSENC_REQUEST = 80877104;
export const CANCEL_REQUEST = 80877102;
export const PROTOCOL_3_0 = 196608;
/** Largest frontend message the proxy buffers (Postgres itself allows 1 GB; COPY data comes in small messages). */
export const MAX_MESSAGE = 64 * 1024 * 1024;

export interface Message {
  type: string;
  body: Buffer;
  /** The whole message as it arrived (type byte, length, body). */
  raw: Buffer;
}

/** Splits a byte stream into messages: untyped startup packets first, then typed messages. */
export class MessageReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  /** An untyped packet (int32 length including itself, then the body), or null if incomplete. */
  startup(): Buffer | null {
    if (this.buf.length < 4) return null;
    const len = this.buf.readInt32BE(0);
    if (len < 8 || len > 10_000) throw new Error('invalid startup packet');
    if (this.buf.length < len) return null;
    const out = this.buf.subarray(4, len);
    this.buf = this.buf.subarray(len);
    return out;
  }

  /** A typed message, or null if incomplete. */
  next(): Message | null {
    if (this.buf.length < 5) return null;
    const len = this.buf.readInt32BE(1);
    if (len < 4 || len > MAX_MESSAGE) throw new Error(`message of ${len} bytes is larger than the proxy accepts`);
    if (this.buf.length < len + 1) return null;
    const raw = this.buf.subarray(0, len + 1);
    this.buf = this.buf.subarray(len + 1);
    return { type: String.fromCharCode(raw[0]!), body: raw.subarray(5), raw };
  }

  /** Bytes received but not yet returned as a message. */
  rest(): Buffer {
    const out = this.buf;
    this.buf = Buffer.alloc(0);
    return out;
  }
}

export function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

export const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

/** NUL-terminated strings from `from` up to an empty one (the SASL mechanism list). */
export function cstrings(body: Buffer, from = 0): string[] {
  const out: string[] = [];
  let at = from;
  while (at < body.length) {
    const z = body.indexOf(0, at);
    if (z < 0 || z === at) break;
    out.push(body.toString('utf8', at, z));
    at = z + 1;
  }
  return out;
}

/** A startup packet's parameters (user, database, application_name, …). */
export function startupParams(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 4;
  while (at < body.length && body[at] !== 0) {
    const kz = body.indexOf(0, at);
    const vz = body.indexOf(0, kz + 1);
    if (kz < 0 || vz < 0) break;
    out[body.toString('utf8', at, kz)] = body.toString('utf8', kz + 1, vz);
    at = vz + 1;
  }
  return out;
}

export function startupPacket(params: Record<string, string>): Buffer {
  const body = Buffer.concat([int32(PROTOCOL_3_0), ...Object.entries(params).flatMap(([k, v]) => [cstr(k), cstr(v)]), Buffer.from([0])]);
  return Buffer.concat([int32(body.length + 4), body]);
}

/** Fields of an ErrorResponse/NoticeResponse body by their one-letter code (S, C, M, H, …). */
export function errorFields(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = String.fromCharCode(body[at]!);
    const z = body.indexOf(0, at + 1);
    if (z < 0) break;
    out[code] = body.toString('utf8', at + 1, z);
    at = z + 1;
  }
  return out;
}

export function errorResponse(f: { severity: 'ERROR' | 'FATAL'; code: string; message: string; hint?: string }): Buffer {
  const parts = [Buffer.from('S'), cstr(f.severity), Buffer.from('V'), cstr(f.severity), Buffer.from('C'), cstr(f.code), Buffer.from('M'), cstr(f.message)];
  if (f.hint) parts.push(Buffer.from('H'), cstr(f.hint));
  parts.push(Buffer.from([0]));
  return message('E', Buffer.concat(parts));
}

export const authenticationOk = () => message('R', int32(0));
export const readyForQuery = (status: 'I' | 'T' | 'E' = 'I') => message('Z', Buffer.from(status, 'latin1'));
export function backendKeyData(pid: number, secret: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32BE(pid, 0);
  b.writeInt32BE(secret, 4);
  return message('K', b);
}

/** A server error during login, kept with its SQLSTATE so callers can tell a bad password apart. */
export class PgError extends Error {
  constructor(
    readonly fields: Record<string, string>,
    readonly code = fields.C,
  ) {
    super(fields.M ?? 'database error');
  }
}

export interface Login {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** TLS is required except for a database on this machine (tests). */
  tls: boolean;
}

export function loginOf(url: string): Login {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) || 'postgres', tls: !local };
}

/** Reads typed messages from a socket; leftover bytes stay in the reader. `detach` removes the listeners. */
function messages(socket: Socket | TLSSocket, reader: MessageReader): { next: () => Promise<Message>; detach: () => void } {
  const queue: Message[] = [];
  let waiting: { resolve: (m: Message) => void; reject: (e: Error) => void } | null = null;
  let failed: Error | null = null;
  const pump = () => {
    try {
      for (let m = reader.next(); m; m = reader.next()) queue.push(m);
    } catch (err) {
      failed = err as Error;
    }
    if (waiting && (queue.length || failed)) {
      const w = waiting;
      waiting = null;
      if (queue.length) w.resolve(queue.shift()!);
      else w.reject(failed!);
    }
  };
  const onData = (d: Buffer) => {
    reader.push(d);
    pump();
  };
  const onError = (e: Error) => {
    failed ??= e;
    pump();
  };
  const onClose = () => onError(new Error('the database closed the connection during login'));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    next: () =>
      new Promise<Message>((resolve, reject) => {
        if (queue.length) return resolve(queue.shift()!);
        if (failed) return reject(failed);
        waiting = { resolve, reject };
      }),
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

/** TCP, then SSLRequest and TLS with SNI (Neon routes by the server name). */
async function openSocket(login: Login, timeoutMs: number): Promise<Socket | TLSSocket> {
  const tcp = netConnect({ host: login.host, port: login.port });
  tcp.setNoDelay(true);
  tcp.setKeepAlive(true, 30_000);
  const timer = setTimeout(() => tcp.destroy(new Error(`no answer from the database within ${timeoutMs / 1000} s`)), timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once('connect', resolve);
      tcp.once('error', reject);
    });
    if (!login.tls) return tcp;
    const req = Buffer.alloc(8);
    req.writeInt32BE(8, 0);
    req.writeInt32BE(SSL_REQUEST, 4);
    tcp.write(req);
    const answer = await new Promise<Buffer>((resolve, reject) => {
      tcp.once('data', resolve);
      tcp.once('error', reject);
      tcp.once('close', () => reject(new Error('the database closed the connection')));
    });
    if (answer[0] !== 0x53) throw new Error('the database refused TLS');
    const tls = tlsConnect({ socket: tcp, servername: login.host, rejectUnauthorized: true });
    await new Promise<void>((resolve, reject) => {
      tls.once('secureConnect', resolve);
      tls.once('error', reject);
    });
    return tls;
  } catch (err) {
    tcp.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const pbkdf2Async = promisify(pbkdf2);
const hmac = (key: Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** SCRAM-SHA-256 without channel binding (RFC 5802/7677), as libpq does with channel_binding=disable. */
async function scram(next: () => Promise<Message>, send: (b: Buffer) => void, mechanisms: string[], password: string): Promise<void> {
  if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error(`the database offers no supported SASL mechanism (${mechanisms.join(', ')})`);
  const nonce = randomBytes(18).toString('base64');
  const clientFirstBare = `n=,r=${nonce}`;
  const first = Buffer.from(`n,,${clientFirstBare}`);
  send(message('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first])));
  const cont = await next();
  if (cont.type === 'E') throw new PgError(errorFields(cont.body));
  if (cont.type !== 'R' || cont.body.readInt32BE(0) !== 11) throw new Error('unexpected SASL answer from the database');
  const serverFirst = cont.body.subarray(4).toString('utf8');
  const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
  if (!attrs.r?.startsWith(nonce) || !attrs.s || !attrs.i) throw new Error('invalid SCRAM server-first message');
  const salted = await pbkdf2Async(password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  const finalWithoutProof = `c=biws,r=${attrs.r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${finalWithoutProof}`;
  const signature = hmac(storedKey, authMessage);
  const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]!));
  send(message('p', Buffer.from(`${finalWithoutProof},p=${proof.toString('base64')}`)));
  const fin = await next();
  if (fin.type === 'E') throw new PgError(errorFields(fin.body));
  if (fin.type !== 'R' || fin.body.readInt32BE(0) !== 12) throw new Error('unexpected SASL answer from the database');
  const v = /v=([^,]+)/.exec(fin.body.subarray(4).toString('utf8'))?.[1] ?? '';
  const expected = hmac(hmac(salted, 'Server Key'), authMessage);
  const got = Buffer.from(v, 'base64');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('the database failed SCRAM server verification');
}

export interface Upstream {
  socket: Socket | TLSSocket;
  /** ParameterStatus/Notice messages and the final ReadyForQuery, to replay to the client. */
  greeting: Buffer[];
  pid: number;
  secret: number;
  /** Bytes after ReadyForQuery (none in practice). */
  rest: Buffer;
}

/**
 * Logs in to the database: the session starts as `login.user`, whatever the local client
 * claimed. Resolves after ReadyForQuery; a server error (bad password, no such database) rejects
 * with PgError.
 */
export async function connectUpstream(login: Login, params: Record<string, string>, timeoutMs = 30_000): Promise<Upstream> {
  const socket = await openSocket(login, timeoutMs);
  const reader = new MessageReader();
  const { next, detach } = messages(socket, reader);
  const send = (b: Buffer) => socket.write(b);
  const timer = setTimeout(() => socket.destroy(new Error(`the database did not complete the login within ${timeoutMs / 1000} s`)), timeoutMs);
  try {
    send(startupPacket({ ...params, user: login.user, database: login.database }));
    const greeting: Buffer[] = [];
    let pid = 0;
    let secret = 0;
    for (;;) {
      const m = await next();
      if (m.type === 'E') throw new PgError(errorFields(m.body));
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) send(message('p', cstr(login.password)));
        else if (code === 5) {
          const inner = createHash('md5').update(login.password + login.user).digest('hex');
          send(message('p', cstr(`md5${createHash('md5').update(inner).update(m.body.subarray(4, 8)).digest('hex')}`)));
        } else if (code === 10) await scram(next, send, cstrings(m.body, 4), login.password);
        else throw new Error(`the database asked for an unsupported authentication method (${code})`);
        continue;
      }
      if (m.type === 'K') {
        pid = m.body.readInt32BE(0);
        secret = m.body.readInt32BE(4);
        continue;
      }
      greeting.push(m.raw);
      if (m.type === 'Z') break;
    }
    // The caller takes the socket over: paused until it attaches its own listeners.
    socket.pause();
    detach();
    return { socket, greeting, pid, secret, rest: reader.rest() };
  } catch (err) {
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Forwards a cancel request for (pid, secret) to the database, over TLS like a login (the key stays private). */
export async function sendCancel(login: Login, pid: number, secret: number): Promise<void> {
  const socket = await openSocket(login, 10_000);
  socket.on('error', () => undefined);
  const b = Buffer.alloc(16);
  b.writeInt32BE(16, 0);
  b.writeInt32BE(CANCEL_REQUEST, 4);
  b.writeInt32BE(pid, 8);
  b.writeInt32BE(secret, 12);
  socket.end(b);
}

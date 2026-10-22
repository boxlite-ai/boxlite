/**
 * One Postgres session through `boxlite-app app db proxy`: the local client's bytes arrive over a
 * WebSocket; the CP answers the client's startup itself (any user, no password: the App key on
 * the WebSocket is the authentication), logs in to the App's database as the reader (default) or
 * the owner (`--write`), and from then on passes bytes both ways. Frontend messages that carry SQL
 * (simple Query, Parse) go through the SQL guard first (sqlguard.ts proxyRefusal); a refused one
 * is replaced by a statement that raises the refusal as an error, so the database itself answers
 * it in order and with its own transaction semantics.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { proxyRefusal, type ProxySession } from '../sqlguard.js';
import {
  CANCEL_REQUEST,
  GSSENC_REQUEST,
  MessageReader,
  PROTOCOL_3_0,
  PgError,
  SSL_REQUEST,
  authenticationOk,
  backendKeyData,
  connectUpstream,
  cstr,
  errorResponse,
  loginOf,
  message,
  sendCancel,
  startupParams,
  type Login,
  type Upstream,
} from './pgwire.js';
import type { WsConn } from './websocket.js';

/** Client startup parameters passed on to the database; `options` and `replication` never are. */
const PASSED_PARAMS = ['application_name', 'client_encoding', 'DateStyle', 'TimeZone', 'IntervalStyle', 'extra_float_digits'];

export interface SessionTarget extends ProxySession {
  /** App id: a cancel request is honoured only for a session of the same App. */
  appId: string;
  /** Login URL of the role this session uses; `refresh` after a refused reader login. */
  login(refresh: boolean): Promise<string>;
  onOpen(): void;
  onClose(stats: { statements: number; refused: number }): void;
}

/** Fake backend key (handed to the client) → the database's real one. */
const cancelKeys = new Map<string, { appId: string; login: Login; pid: number; secret: number }>();

/** `DO … RAISE`: the database reports the refusal as an ordinary error, in order. */
export function raiseStatement(msg: string, hint: string): string {
  // No backslashes and quotes doubled: the literal means the same whatever standard_conforming_strings says.
  const lit = (s: string) => `'${s.replace(/[\\\u0000-\u001f]/g, ' ').replace(/'/g, "''")}'`;
  const tag = `$bxl${randomBytes(6).toString('hex')}$`;
  return `DO ${tag}BEGIN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = ${lit(`BoxLite: ${msg}`)}, HINT = ${lit(hint)}; END${tag}`;
}

/** The simple-query message `Q`, checked; a refused one becomes a `DO … RAISE`. */
function checkQuery(m: { body: Buffer; raw: Buffer }, target: SessionTarget): { out: Buffer; refused: boolean } {
  const sql = m.body.toString('utf8', 0, Math.max(0, m.body.indexOf(0)));
  const no = proxyRefusal(sql, target);
  if (!no) return { out: m.raw, refused: false };
  return { out: message('Q', cstr(raiseStatement(no.message, no.hint))), refused: true };
}

/** Parse `P`: name, query, parameter types. A refused query keeps the name and enough parameters for the client's Bind. */
function checkParse(m: { body: Buffer; raw: Buffer }, target: SessionTarget): { out: Buffer; refused: boolean } {
  const nameEnd = m.body.indexOf(0);
  const queryEnd = m.body.indexOf(0, nameEnd + 1);
  if (nameEnd < 0 || queryEnd < 0) return { out: m.raw, refused: false };
  const sql = m.body.toString('utf8', nameEnd + 1, queryEnd);
  const no = proxyRefusal(sql, target);
  if (!no) return { out: m.raw, refused: false };
  const declared = m.body.length >= queryEnd + 3 ? m.body.readInt16BE(queryEnd + 1) : 0;
  const n = Math.max(declared, no.params);
  const types = Buffer.alloc(2 + 4 * n);
  types.writeInt16BE(n, 0);
  for (let i = 0; i < n; i++) types.writeInt32BE(i < declared ? m.body.readInt32BE(queryEnd + 3 + 4 * i) : 25 /* text */, 2 + 4 * i);
  return { out: message('P', Buffer.concat([m.body.subarray(0, nameEnd + 1), cstr(raiseStatement(no.message, no.hint)), types])), refused: true };
}

export function runSession(ws: WsConn, target: SessionTarget): void {
  const reader = new MessageReader();
  let phase: 'startup' | 'login' | 'live' | 'closed' = 'startup';
  let upstream: Upstream | null = null;
  let fakeKey: string | null = null;
  let opened = false;
  const stats = { statements: 0, refused: 0 };

  const fatal = (code: string, msg: string, hint?: string) => {
    ws.send(errorResponse({ severity: 'FATAL', code, message: msg, hint }));
    close();
  };
  const close = () => {
    if (phase === 'closed') return;
    phase = 'closed';
    upstream?.socket.destroy();
    if (fakeKey) cancelKeys.delete(fakeKey);
    ws.close();
    if (opened) target.onClose(stats);
  };
  ws.on('close', close);

  const login = async (params: Record<string, string>) => {
    phase = 'login';
    const passed: Record<string, string> = {};
    for (const k of PASSED_PARAMS) if (params[k] !== undefined) passed[k] = params[k]!;
    passed.application_name = `boxlite-proxy${params.application_name ? `:${params.application_name}` : ''}`.slice(0, 63);
    let up: Upstream;
    let creds: Login;
    try {
      creds = loginOf(await target.login(false));
      try {
        up = await connectUpstream(creds, passed);
      } catch (err) {
        // A refused reader login: its password changed (dbreader.ts). Fetch it again, once.
        if (!(err instanceof PgError && (err.code === '28P01' || err.code === '28000')) || target.write) throw err;
        creds = loginOf(await target.login(true));
        up = await connectUpstream(creds, passed);
      }
    } catch (err) {
      if (err instanceof PgError) return fatal(err.code ?? '08006', err.message);
      const e = err as { message?: string; code?: string; next?: string };
      return fatal('08006', `cannot reach the app database: ${e.message ?? String(err)}`, e.next ?? 'wait 30 s and reconnect (the database starts on first connection)');
    }
    // The client may have gone while the login ran.
    if ((phase as string) === 'closed') {
      up.socket.destroy();
      return;
    }
    upstream = up;
    opened = true;
    target.onOpen();
    // The client never sees the database's backend key: a cancel comes back through the CP.
    const pid = randomInt(1, 2 ** 31 - 1);
    const secret = randomInt(1, 2 ** 31 - 1);
    fakeKey = `${pid}:${secret}`;
    cancelKeys.set(fakeKey, { appId: target.appId, login: creds, pid: up.pid, secret: up.secret });
    const z = up.greeting.pop()!;
    ws.send(Buffer.concat([authenticationOk(), ...up.greeting, backendKeyData(pid, secret), z]));
    if (up.rest.length) ws.send(up.rest);
    const sock = up.socket;
    sock.on('data', (d: Buffer) => {
      if (!ws.send(d)) {
        sock.pause();
        ws.socket.once('drain', () => sock.resume());
      }
    });
    sock.on('close', close);
    sock.on('error', close);
    sock.on('drain', () => ws.resume());
    sock.resume();
    phase = 'live';
    forward();
  };

  /** Passes complete frontend messages on, checking those that carry SQL. */
  const forward = () => {
    if (phase !== 'live' || !upstream) return;
    const out: Buffer[] = [];
    try {
      for (let m = reader.next(); m; m = reader.next()) {
        if (m.type === 'Q' || m.type === 'P') {
          const checked = m.type === 'Q' ? checkQuery(m, target) : checkParse(m, target);
          stats.statements++;
          if (checked.refused) stats.refused++;
          out.push(checked.out);
        } else if (m.type === 'F') {
          if (out.length) upstream.socket.write(Buffer.concat(out));
          return fatal('0A000', 'the fast-path function call protocol is not supported through the BoxLite proxy');
        } else out.push(m.raw);
        if (m.type === 'X') {
          upstream.socket.end(Buffer.concat(out));
          return close();
        }
      }
    } catch (err) {
      return fatal('08P01', (err as Error).message);
    }
    if (out.length && !upstream.socket.write(out.length === 1 ? out[0]! : Buffer.concat(out))) ws.pause();
  };

  /** SSLRequest/GSSENCRequest (answer "no": the WebSocket is the encrypted leg), CancelRequest, StartupMessage. */
  const startup = () => {
    for (;;) {
      let packet: Buffer | null;
      try {
        packet = reader.startup();
      } catch (err) {
        return fatal('08P01', (err as Error).message);
      }
      if (!packet) return;
      const code = packet.readInt32BE(0);
      if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
        ws.send(Buffer.from('N'));
        continue;
      }
      if (code === CANCEL_REQUEST) {
        const key = cancelKeys.get(`${packet.readInt32BE(4)}:${packet.readInt32BE(8)}`);
        if (key && key.appId === target.appId) void sendCancel(key.login, key.pid, key.secret).catch(() => undefined);
        return close();
      }
      if (code >> 16 !== 3) return fatal('0A000', `unsupported frontend protocol ${code >> 16}.${code & 0xffff}: the BoxLite proxy speaks 3.0`);
      const params = startupParams(packet);
      if (params.replication !== undefined) return fatal('42501', 'replication connections are not allowed through the BoxLite proxy');
      // A newer minor version or protocol options (`_pq_.*`): say what this side speaks (3.0, none).
      const options = Object.keys(params).filter((k) => k.startsWith('_pq_.'));
      if (code !== PROTOCOL_3_0 || options.length) {
        const b = Buffer.alloc(8);
        b.writeInt32BE(0, 0);
        b.writeInt32BE(options.length, 4);
        ws.send(message('v', Buffer.concat([b, ...options.map(cstr)])));
      }
      void login(params);
      return;
    }
  };

  ws.on('data', (d) => {
    reader.push(d);
    if (phase === 'startup') startup();
    else if (phase === 'live') forward();
  });
}

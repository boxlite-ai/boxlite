/**
 * Just enough RFC 6455 for the database proxy: the server side of one WebSocket carrying a byte
 * stream in binary messages. No extensions, no text payloads; pings are answered, a ping is sent
 * every 25 s so idle tunnels and proxies keep the connection, and the TCP socket's backpressure is
 * exposed as pause()/resume() of incoming data plus the boolean from send().
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest frame accepted from a client; the CLI sends what one socket read returns (≤ 64 KiB). */
export const MAX_FRAME = 16 * 1024 * 1024;
const PING_EVERY_MS = 25_000;

export interface WsEvents {
  data: [Buffer];
  close: [];
}

export class WsConn extends EventEmitter<WsEvents> {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  private readonly ping: NodeJS.Timeout;

  constructor(readonly socket: Duplex) {
    super();
    socket.on('data', (d: Buffer) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    this.ping = setInterval(() => this.frame(0x9, Buffer.alloc(0)), PING_EVERY_MS);
    this.ping.unref();
  }

  /** Sends bytes as one binary message; false when the socket's buffer is full (wait for 'drain'). */
  send(data: Buffer): boolean {
    return this.frame(0x2, data);
  }

  /** A close frame, then the TCP connection ends. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 120));
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.frame(0x8, body);
    this.socket.end();
    this.finish();
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    this.socket.destroy();
    this.emit('close');
  }

  private frame(opcode: number, payload: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(head);
    return this.socket.write(payload);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0]! & 0x80) !== 0;
      const opcode = this.buf[0]! & 0x0f;
      const masked = (this.buf[1]! & 0x80) !== 0;
      let len = this.buf[1]! & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) return this.close(1009, 'frame too large');
        len = Number(big);
        at = 10;
      }
      // Clients must mask (RFC 6455 5.1); an unmasked frame is a protocol error.
      if (!masked) return this.close(1002, 'unmasked frame');
      if (len > MAX_FRAME) return this.close(1009, 'frame too large');
      if (this.buf.length < at + 4 + len) return;
      const mask = this.buf.subarray(at, at + 4);
      const payload = Buffer.from(this.buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buf = this.buf.subarray(at + 4 + len);
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1) return this.close(1003, 'binary messages only');
      if (opcode !== 0x0 && opcode !== 0x2) return this.close(1002, 'unknown opcode');
      if (!fin) {
        this.fragments.push(payload);
        if (this.fragments.reduce((a, b) => a + b.length, 0) > MAX_FRAME) return this.close(1009, 'message too large');
        continue;
      }
      const message = this.fragments.length ? Buffer.concat([...this.fragments, payload]) : payload;
      this.fragments = [];
      if (message.length) this.emit('data', message);
    }
  }
}

/** Answers a plain HTTP error on an upgrade request and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] ?? 'Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
}

/** Completes the WebSocket handshake, or answers 400 and returns null. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    refuseUpgrade(socket, 400, { error: { code: 'invalid_request', message: 'expected a WebSocket upgrade (version 13)', next: 'connect with `boxlite-app app db proxy`' } });
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (head.length) socket.unshift(head);
  return new WsConn(socket);
}

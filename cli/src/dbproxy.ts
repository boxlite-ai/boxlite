/**
 * The local end of `boxlite-app app db proxy` (and of `app dev`'s DATABASE_URL): a Postgres port on
 * 127.0.0.1 whose every connection is carried to the control plane over its own WebSocket
 * (`/v1/apps/{app}/envs/{env}/db/connect`, App key in the Authorization header). The control plane
 * answers the Postgres login itself and connects to the database; this side never sees a database
 * password, and the client may use any user name and password.
 */
import { createServer, type Server, type Socket } from 'node:net';

/** The parts of a WebSocket the bridge uses (undici's in the CLI, Node's global one in tests). */
export interface BridgeSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

export interface DbBridge {
  port: number;
  /** Connections currently open. */
  open(): number;
  close(): Promise<void>;
}

export interface BridgeEvents {
  /** A connection's WebSocket could not be opened or failed (key revoked, control plane down, …). */
  onError?(message: string): void;
}

/** ErrorResponse (FATAL, 08006) for a local client whose connection could not reach the control plane. */
function fatal(message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C08006\0M${message}\0\0`, 'utf8');
  const head = Buffer.alloc(5);
  head.write('E', 0, 'latin1');
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

export function startDbBridge(open: () => BridgeSocket, port: number, events: BridgeEvents = {}, host = '127.0.0.1'): Promise<DbBridge> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.setNoDelay(true);
    let ws: BridgeSocket;
    try {
      ws = open();
    } catch (err) {
      sock.end(fatal(`BoxLite proxy: ${(err as Error).message}`));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const pending: Buffer[] = [];
    let opened = false;
    let done = false;
    /** The client closed before the WebSocket opened (a cancel request does): send what it wrote, then close. */
    let closeOnOpen = false;
    const closeWs = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      sockets.delete(sock);
      sock.destroy();
      if (opened) closeWs();
      else closeOnOpen = true;
    };
    ws.addEventListener('open', () => {
      opened = true;
      for (const b of pending.splice(0)) ws.send(b);
      if (closeOnOpen) closeWs();
    });
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      sock.write(d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d as Uint8Array));
    });
    ws.addEventListener('error', () => {
      if (!opened && !done && !closeOnOpen) {
        const msg = 'BoxLite proxy: the control plane refused or dropped the connection (check BOXLITE_API_KEY and BOXLITE_API_URL; `boxlite-app doctor`)';
        events.onError?.(msg);
        sock.end(fatal(msg));
        done = true;
        sockets.delete(sock);
      }
    });
    ws.addEventListener('close', () => {
      // Let the client read what already arrived (an ErrorResponse, say), then close.
      if (!done) {
        done = true;
        sockets.delete(sock);
        sock.end();
      }
    });
    sock.on('data', (d: Buffer) => {
      if (opened) ws.send(d);
      else pending.push(d);
    });
    sock.on('close', finish);
    sock.on('error', finish);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        open: () => sockets.size,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** What clients put in DATABASE_URL: no password; sslmode=disable because the local leg is loopback (the WebSocket is TLS). */
export function localDatabaseUrl(port: number, database: string): string {
  return `postgresql://boxlite@127.0.0.1:${port}/${encodeURIComponent(database)}?sslmode=disable`;
}

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { serve } from '@hono/node-server';
import type { Context } from 'hono';
import type { BoxliteClient } from './boxlite.js';
import type { Config } from './config.js';
import type { EnvRow, Store } from './db.js';
import { UpstreamError } from './errors.js';
import { sleep } from './http.js';

/**
 * One origin per app env (security review F1, decisions 2026-10-21). The CP runs in BoxLite Box
 * `CP_BOX_ID`; every public URL it has is a tunnel to one of that Box's ports:
 *
 *   port 8080 (PORT)            API origin  = PUBLIC_URL  (/v1, /sv, /admin, /auth, /cli, …)
 *   port 8081 (CONSOLE_PORT)    console origin            (/console/*)
 *   ports 10001–10999           one per app env           (the app at `/`, plus /.boxlite/auth|open)
 *
 * The CP is one Hono app behind one listener per port; a request's role comes from the local port
 * it arrived on (`roleOf`), never from its path or Host header. This module allocates env ports,
 * registers their tunnels and starts their listeners.
 *
 * Local dev: when PUBLIC_URL is `http://localhost:<port>` there are no tunnels; every origin is
 * `http://localhost:<its port>`.
 */

export type TunnelRegistrar = (port: number) => Promise<string>;

export type OriginRole = { kind: 'api' } | { kind: 'console' } | { kind: 'app'; env: EnvRow } | { kind: 'unassigned'; port: number };

/** Starts one HTTP listener per port. Absent in tests, which call `app.request` with a `localPort`. */
export interface ListenerHost {
  listen(port: number): Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The URL a tunnel to `port` gets, derived from the API origin: BoxLite tunnel hosts start with the
 * port (`8080-d-<hex>.proxy.dev.boxlite.ai` → `10001-d-<hex>.proxy.dev.boxlite.ai`). Local URLs
 * swap the port. Other hosts get `<port>-` prepended (tests). The registered tunnel's own answer
 * wins when it differs.
 */
export function deriveOriginUrl(publicUrl: string, port: number): string {
  const u = new URL(publicUrl);
  if (LOCAL_HOSTS.has(u.hostname)) return `${u.protocol}//${u.hostname}:${port}`;
  const [first, ...rest] = u.hostname.split('.');
  const m = /^\d+(-.+)$/.exec(first ?? '');
  const host = m ? [`${port}${m[1]}`, ...rest].join('.') : `${port}-${u.hostname}`;
  return `${u.protocol}//${host}`;
}

/** The local port a request arrived on: set by each listener (`NodeListeners`), or by tests. */
export function localPortOf(c: Context): number | undefined {
  const env = c.env as { localPort?: number; incoming?: IncomingMessage } | undefined;
  return env?.localPort ?? env?.incoming?.socket?.localPort;
}

interface OriginDeps {
  config: Config;
  store: Store;
  boxlite: BoxliteClient;
  registerTunnel?: TunnelRegistrar;
}

export class Origins {
  readonly local: boolean;
  readonly apiPort: number;
  readonly consolePort: number;
  private readonly range: { min: number; max: number };
  private host: ListenerHost | null = null;
  /** Port → the promise that brought it up (listener + tunnel). Failed ones are dropped so a later use retries. */
  private readonly active = new Map<number, Promise<void>>();

  constructor(private readonly deps: OriginDeps) {
    const { config } = deps;
    this.local = isLocalUrl(config.publicUrl);
    this.apiPort = config.port;
    this.consolePort = config.consolePort ?? config.port + 1;
    this.range = config.envPorts ?? { min: 10001, max: 10999 };
  }

  get apiUrl(): string {
    return this.deps.config.publicUrl;
  }

  get secure(): boolean {
    return this.apiUrl.startsWith('https:');
  }

  // ---- settings ---------------------------------------------------------------

  private setting(key: string): string | undefined {
    return this.deps.store.get<{ value: string }>('SELECT value FROM cp_settings WHERE key = ?', key)?.value;
  }

  private setSetting(key: string, value: string): void {
    this.deps.store.run('INSERT INTO cp_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  // ---- URLs -----------------------------------------------------------------

  consoleUrl(): string {
    return (!this.local && this.setting('console_url')) || deriveOriginUrl(this.apiUrl, this.consolePort);
  }

  /**
   * The env's origin URL (no trailing slash). The first call allocates the env's port and brings
   * its origin up in the background (listener, then tunnel); the URL is known before that finishes.
   */
  envUrl(env: EnvRow): string {
    const port = this.portOf(env.id);
    const row = this.deps.store.get<{ public_url: string | null }>('SELECT public_url FROM envs WHERE id = ?', env.id);
    let url = row?.public_url ?? null;
    if (!url) {
      url = deriveOriginUrl(this.apiUrl, port);
      this.deps.store.run('UPDATE envs SET public_url = ? WHERE id = ?', url, env.id);
    }
    void this.activate(port);
    return url;
  }

  // ---- ports ------------------------------------------------------------------

  /** The env's port, allocated on first use: round-robin over the range, so a freed port is reused last. */
  portOf(envId: string): number {
    const { store } = this.deps;
    const have = store.get<{ port: number | null }>('SELECT port FROM envs WHERE id = ?', envId);
    if (!have) throw new Error(`env ${envId} not found`);
    if (have.port) return have.port;
    // node:sqlite is synchronous, so nothing interleaves between the read and the write below; the
    // unique index on envs.port is the backstop. (No transaction: callers may already be in one.)
    const used = new Set(store.all<{ port: number }>('SELECT port FROM envs WHERE port IS NOT NULL').map((r) => r.port));
    const { min, max } = this.range;
    const size = max - min + 1;
    const start = Number(this.setting('next_env_port') ?? min);
    for (let i = 0; i < size; i++) {
      const p = min + ((((start - min + i) % size) + size) % size);
      if (used.has(p) || p === this.apiPort || p === this.consolePort) continue;
      store.run('UPDATE envs SET port = ?, public_url = NULL WHERE id = ? AND port IS NULL', p, envId);
      this.setSetting('next_env_port', String(p + 1 > max ? min : p + 1));
      return p;
    }
    throw new Error(`no free app port left in ${min}–${max}`);
  }

  roleOf(port: number | undefined): OriginRole {
    if (port === undefined || port === this.apiPort) return { kind: 'api' };
    if (port === this.consolePort) return { kind: 'console' };
    const env = this.deps.store.get<EnvRow>('SELECT * FROM envs WHERE port = ?', port);
    return env ? { kind: 'app', env } : { kind: 'unassigned', port };
  }

  // ---- listeners and tunnels --------------------------------------------------------

  /**
   * At CP start: listen on the console port and every allocated env port, and (re-)register their
   * tunnels. Registration is idempotent on BoxLite's side and returns the same URL.
   */
  async boot(host: ListenerHost | null): Promise<void> {
    this.host = host;
    // Origins touched before boot (e.g. by orchestrator.resume) came up without a listener host.
    this.active.clear();
    const envs = this.deps.store.all<EnvRow>('SELECT * FROM envs');
    await Promise.all([this.activate(this.consolePort), ...envs.map((e) => this.activate(this.portOf(e.id)))]);
  }

  /** Resolves when every origin started so far is up (or has failed and logged). Tests await it. */
  async settled(): Promise<void> {
    await Promise.all([...this.active.values()]);
  }

  private activate(port: number): Promise<void> {
    let p = this.active.get(port);
    if (!p) {
      p = this.bringUp(port).catch((err) => {
        this.active.delete(port);
        console.error(`[origins] port ${port}: ${(err as Error).message}`);
      });
      this.active.set(port, p);
    }
    return p;
  }

  private async bringUp(port: number): Promise<void> {
    if (this.host) await this.listenWithRetry(port);
    if (this.local) return;
    const uri = (await this.register(port)).replace(/\/+$/, '');
    if (port === this.consolePort) {
      this.setSetting('console_url', uri);
      return;
    }
    const env = this.deps.store.get<{ id: string; public_url: string | null }>('SELECT id, public_url FROM envs WHERE port = ?', port);
    if (!env) return;
    if (env.public_url && env.public_url !== uri) console.warn(`[origins] tunnel for port ${port} is ${uri}, not the derived ${env.public_url}; using the tunnel's`);
    this.deps.store.run('UPDATE envs SET public_url = ? WHERE id = ?', uri, env.id);
  }

  /**
   * A port can stay held for a moment by the previous CP process during a restart, or by a stray
   * process. Giving up would leave that app answering 502 until someone restarts the CP, so keep
   * trying for a few minutes and say so in the log.
   */
  private async listenWithRetry(port: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.host!.listen(port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= LISTEN_ATTEMPTS) throw err;
        if (attempt === 1) console.warn(`[origins] port ${port} is in use; retrying for up to ${(LISTEN_ATTEMPTS * LISTEN_RETRY_MS) / 1000}s`);
        await sleep(LISTEN_RETRY_MS);
      }
    }
  }

  private async register(port: number): Promise<string> {
    const register = this.deps.registerTunnel ?? ((p: number) => this.deps.boxlite.tunnel(this.deps.config.cpBoxId ?? 'microcloud-cp', p));
    for (let attempt = 1; ; attempt++) {
      try {
        return await register(port);
      } catch (err) {
        if (attempt >= 5 || !(err instanceof UpstreamError)) throw err;
        await sleep(3_000 * attempt);
      }
    }
  }
}

const LISTEN_ATTEMPTS = 60;
const LISTEN_RETRY_MS = 3_000;

type FetchFn = (req: Request, env: Record<string, unknown>) => Response | Promise<Response>;
type UpgradeFn = (req: IncomingMessage, socket: Duplex, head: Buffer, localPort: number) => void;

/** Real listeners: one `serve()` per port over the same Hono app, each tagging requests with its port. */
export class NodeListeners implements ListenerHost {
  private readonly servers = new Map<number, Promise<Server>>();

  constructor(
    private readonly fetch: FetchFn,
    private readonly upgrade: UpgradeFn,
    private readonly hostname = '0.0.0.0',
  ) {}

  listen(port: number): Promise<void> {
    let s = this.servers.get(port);
    if (!s) {
      s = new Promise<Server>((resolve, reject) => {
        const server = serve({ fetch: (req, env) => this.fetch(req, { ...(env as Record<string, unknown>), localPort: port }), port, hostname: this.hostname }, () => resolve(server)) as Server;
        server.once('error', (err) => {
          this.servers.delete(port);
          reject(err);
        });
        server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, port));
        // SSE streams and slow uploads must not be cut by Node's default request timeout.
        server.requestTimeout = 0;
        server.headersTimeout = 60_000;
      });
      this.servers.set(port, s);
    }
    return s.then(() => undefined);
  }

  get ports(): number[] {
    return [...this.servers.keys()];
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((p) => p.then((s) => new Promise<void>((r) => s.close(() => r()))).catch(() => undefined)));
  }
}

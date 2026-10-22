import { MicrocloudError, type AgentContext, type CheckError, type CheckWarning, type Manifest, type MigrationFile, type UploadFile } from '@microcloud/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fetch, WebSocket, type Dispatcher, type Response } from 'undici';
import type { Readable } from 'node:stream';
import type { PlanChange } from './output.js';
import { parseJsonData, parseSse, type SseEvent } from './sse.js';

export interface EnvSummary {
  name: string;
  status?: string;
  url?: string;
  spec_version?: number;
  latest_deployment?: { number: number; status: string; spec_version?: number } | null;
  [extra: string]: unknown;
}

export interface AppInfo {
  name: string;
  envs?: EnvSummary[];
  [extra: string]: unknown;
}

export interface PlanRequest {
  manifest: Manifest;
  base_version: number;
  migrations: MigrationFile[];
  upload?: { files: number; bytes: number; warnings: string[] };
}

export interface PlanResponse {
  latest_version: number;
  stale: boolean;
  changes: PlanChange[];
  errors: CheckError[];
  warnings: CheckWarning[];
}

export interface DeploymentStep {
  name: string;
  status: string;
  ms?: number;
  detail?: string;
}

export interface DeploymentError {
  step?: string;
  message?: string;
  log_tail?: string[];
}

export interface Deployment {
  number: number;
  kind: string;
  status: string;
  message?: string | null;
  by?: string;
  created_at?: string;
  finished_at?: string | null;
  spec_version?: number;
  base_version?: number;
  snapshot_id?: string | null;
  steps?: DeploymentStep[];
  changes?: PlanChange[];
  error?: DeploymentError | null;
  url?: string;
  log_tail?: string[];
  [extra: string]: unknown;
}

export type DeploymentRequest =
  | { kind: 'deploy' | 'apply'; snapshot_id?: string; manifest: Manifest; migrations: MigrationFile[]; base_version: number; message?: string; force?: boolean }
  | { kind: 'rollback'; to: number; with_database?: boolean };

export interface StepEvent {
  name: string;
  status: 'running' | 'done' | 'failed' | string;
  ms?: number;
  detail?: string;
}

export interface LogEvent {
  ts?: string;
  source?: string;
  level?: string;
  line: string;
}

export interface DoneEvent {
  status: string;
  deployment: Deployment;
}

export interface ServiceStatus {
  name: string;
  state: string;
  restarts?: number;
  last_exit_code?: number | null;
  health?: string;
  pid?: number | null;
}

export interface DbInfo {
  status: string;
  host?: string;
  database?: string;
  user?: string;
  branch?: string;
  size_bytes?: number;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  elapsed_ms: number;
  row_count: number;
}

export interface DbImport {
  table: string;
  rows: number;
  columns: string[];
  snapshot: string;
}

export interface MigrationStatus {
  file: string;
  status: 'applied' | 'pending' | 'changed' | string;
  deployment?: number;
}

export interface DbSnapshot {
  id: string;
  message?: string;
  created_at?: string;
  [extra: string]: unknown;
}

export interface LogsQuery {
  source?: string;
  since?: string;
  limit?: number;
}

export interface LogSearch extends LogsQuery {
  level?: string;
  until?: string;
  deployment?: number;
}

export interface LogLine {
  id?: number;
  ts: string;
  source: string;
  level: string;
  line: string;
  deployment: number | null;
}

export interface ApiOptions {
  baseUrl: string;
  key: string;
  app?: string;
  env?: string;
  dispatcher?: Dispatcher;
}

interface RequestOptions {
  body?: unknown;
  raw?: Buffer;
  /** A streamed request body (never retried). */
  stream?: { body: Readable; type: string };
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  accept?: string;
  signal?: AbortSignal;
  noRetry?: boolean;
}

const RATE_LIMIT_RETRIES = 3;
const RETRIES = 2;
const RETRY_DELAY_MS = 500;
const TRANSIENT = new Set([502, 503, 504]);

/** A connection failure explained by its cause, the way a person would check it. */
export function networkError(e: Error, url: URL): MicrocloudError {
  const cause = (e as Error & { cause?: Error & { code?: string } }).cause;
  const code = cause?.code ?? (e as Error & { code?: string }).code ?? '';
  const host = url.host;
  const why: Record<string, string> = {
    ENOTFOUND: `cannot resolve ${host} (DNS lookup failed)`,
    EAI_AGAIN: `cannot resolve ${host} (DNS lookup failed)`,
    ECONNREFUSED: `connection to ${host} refused; the control plane is not running there`,
    ECONNRESET: `connection to ${host} was reset; a proxy or VPN may be interfering`,
    ETIMEDOUT: `connection to ${host} timed out`,
    UND_ERR_CONNECT_TIMEOUT: `connection to ${host} timed out`,
    UND_ERR_SOCKET: `connection to ${host} was closed unexpectedly`,
    CERT_HAS_EXPIRED: `TLS certificate of ${host} is not trusted (${code})`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `TLS certificate of ${host} is not trusted (${code})`,
    SELF_SIGNED_CERT_IN_CHAIN: `TLS certificate of ${host} is not trusted (${code})`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `TLS certificate of ${host} is not trusted (${code})`,
  };
  const message = why[code] ?? `cannot reach ${url.origin}: ${cause?.message ?? e.message}`;
  return new MicrocloudError('unavailable', message, `check BOXLITE_API_URL (now ${url.origin}) against the App prompt; then \`curl -fsS ${url.origin}/healthz\` should print ok`, { url: url.origin, ...(code ? { cause: code } : {}) });
}

const STATUS_CODES: Record<number, string> = { 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 502: 'unavailable', 503: 'unavailable', 504: 'unavailable' };

/** Typed client for the `/v1` control-plane API (contracts §1 and §4) with the error → exit-code mapping. */
export class Api {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly appName: string | undefined;
  private readonly envName: string | undefined;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.key = opts.key;
    this.appName = opts.app;
    this.envName = opts.env;
    this.dispatcher = opts.dispatcher;
  }

  /** Same credentials, scoped to another App or environment. */
  scoped(app: string, env?: string): Api {
    return new Api({ baseUrl: this.baseUrl, key: this.key, app, env: env ?? this.envName, dispatcher: this.dispatcher });
  }

  private get app(): string {
    if (!this.appName) throw new MicrocloudError('not_linked', 'this directory is not linked to an App', 'run `boxlite-app init` here, or set BOXLITE_APP');
    return encodeURIComponent(this.appName);
  }

  private get envPath(): string {
    if (!this.envName) throw new MicrocloudError('not_linked', 'no environment selected', 'pass --env <name>');
    return `/v1/apps/${this.app}/envs/${encodeURIComponent(this.envName)}`;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, accept: opts.accept ?? 'application/json', ...opts.headers };
    let body: string | Buffer | undefined;
    let stream: Readable | undefined;
    if (opts.stream) {
      stream = opts.stream.body;
      headers['content-type'] = opts.stream.type;
    } else if (opts.raw !== undefined) {
      body = opts.raw;
      headers['content-type'] = 'application/octet-stream';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    // Reads are retried on network errors and 502/503/504; writes never are (not idempotent).
    const attempts = method === 'GET' && !opts.noRetry ? RETRIES + 1 : 1;
    // A 429 is refused before the control plane does anything, so every method may wait and retry.
    let rateLimited = 0;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: stream ?? body, ...(stream ? { duplex: 'half' as const } : {}), signal: opts.signal, ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (attempt < attempts) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw networkError(e as Error, url);
      }
      if (res.ok) return res;
      if (res.status === 429 && rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited++;
        attempt--;
        const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 30);
        await res.body?.cancel().catch(() => undefined);
        await sleep(wait * 1000);
        continue;
      }
      if (attempt < attempts && TRANSIENT.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw await this.toError(res, method, path);
    }
  }

  private async toError(res: Response, method: string, path: string): Promise<MicrocloudError> {
    const text = await res.text().catch(() => '');
    let parsed: { error?: { code?: string; message?: string; next?: string; [k: string]: unknown } } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const err = parsed?.error;
    if (err && typeof err.code === 'string') {
      const { code, message, next, ...details } = err;
      return new MicrocloudError(code, typeof message === 'string' ? message : `${method} ${path} failed (${res.status})`, typeof next === 'string' ? next : undefined, details);
    }
    const code = STATUS_CODES[res.status] ?? `http_${res.status}`;
    const summary = text.trim().slice(0, 200) || res.statusText;
    return new MicrocloudError(code, `${method} ${path} failed: ${res.status} ${summary}`.trim(), undefined, { status: res.status });
  }

  private async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async *sse(path: string, opts: RequestOptions = {}): AsyncGenerator<SseEvent> {
    const res = await this.request('GET', path, { ...opts, accept: 'text/event-stream' });
    if (!res.body) return;
    yield* parseSse(res.body as unknown as AsyncIterable<Uint8Array>);
  }

  // Apps

  getApp(name = this.appName ?? 'me'): Promise<AppInfo> {
    return this.json('GET', `/v1/apps/${encodeURIComponent(name)}`);
  }

  /** Everything about one environment (cli-extras); `app context` renders it. */
  envContext(): Promise<AgentContext> {
    return this.json('GET', `${this.envPath}/context`);
  }

  whoami(): Promise<WhoAmI> {
    return this.json('GET', `/v1/apps/${encodeURIComponent(this.appName ?? 'me')}/whoami`);
  }

  /** `GET /cli/version` is public; a CP without it answers 404, which callers treat as "unknown". */
  async cliVersion(): Promise<CliVersion | null> {
    try {
      return await this.json<CliVersion>('GET', '/cli/version', { noRetry: true });
    } catch (e) {
      if (e instanceof MicrocloudError && (e.code === 'not_found' || e.code.startsWith('http_'))) return null;
      throw e;
    }
  }

  /** One-time sign-in link for a person (the console's "Open app"); never carries the App key. */
  openTicket(): Promise<{ url: string; expires_at?: string }> {
    return this.json('POST', `${this.envPath}/open-ticket`, { body: {} });
  }

  probe(path?: string): Promise<Probe> {
    return this.json('GET', `${this.envPath}/probe`, { query: { path } });
  }

  listEnvs(): Promise<EnvSummary[]> {
    return this.json('GET', `/v1/apps/${this.app}/envs`);
  }

  createEnv(body: { name: string; from?: string; with_data?: boolean }): Promise<EnvSummary> {
    return this.json('POST', `/v1/apps/${this.app}/envs`, { body });
  }

  deleteEnv(name: string): Promise<void> {
    return this.json('DELETE', `/v1/apps/${this.app}/envs/${encodeURIComponent(name)}`);
  }

  getEnv(): Promise<EnvSummary> {
    return this.json('GET', this.envPath);
  }

  // Spec, plan, uploads, deployments

  getSpec(version?: number): Promise<Record<string, unknown>> {
    return this.json('GET', `${this.envPath}/spec`, { query: { version } });
  }

  plan(body: PlanRequest): Promise<PlanResponse> {
    return this.json('POST', `${this.envPath}/plan`, { body });
  }

  createUpload(manifest: UploadFile[]): Promise<{ upload_id: string; missing: string[] }> {
    return this.json('POST', `/v1/apps/${this.app}/uploads`, { body: { manifest } });
  }

  async putFile(uploadId: string, sha256: string, bytes: Buffer): Promise<void> {
    await this.request('PUT', `/v1/apps/${this.app}/uploads/${encodeURIComponent(uploadId)}/files/${sha256}`, { raw: bytes });
  }

  completeUpload(uploadId: string): Promise<{ snapshot_id: string; files: number; bytes: number }> {
    return this.json('POST', `/v1/apps/${this.app}/uploads/${encodeURIComponent(uploadId)}/complete`, { body: {} });
  }

  createDeployment(body: DeploymentRequest): Promise<Deployment> {
    return this.json('POST', `${this.envPath}/deployments`, { body, headers: { 'idempotency-key': randomUUID() } });
  }

  listDeployments(limit?: number): Promise<Deployment[]> {
    return this.json('GET', `${this.envPath}/deployments`, { query: { limit } });
  }

  getDeployment(n: number): Promise<Deployment> {
    return this.json('GET', `${this.envPath}/deployments/${n}`);
  }

  cancelDeployment(n: number): Promise<Deployment> {
    return this.json('POST', `${this.envPath}/deployments/${n}/cancel`, { body: {} });
  }

  deploymentEvents(n: number, opts: { signal?: AbortSignal; lastEventId?: string } = {}): AsyncGenerator<SseEvent> {
    const headers = opts.lastEventId !== undefined ? { 'last-event-id': opts.lastEventId } : undefined;
    return this.sse(`${this.envPath}/deployments/${n}/events`, { signal: opts.signal, headers });
  }

  async deploymentSource(n: number): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.request('GET', `${this.envPath}/deployments/${n}/source`, { accept: 'application/gzip' });
    if (!res.body) throw new MicrocloudError('unavailable', 'empty source archive', 'retry in a moment');
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }

  // Runtime

  listServices(): Promise<ServiceStatus[]> {
    return this.json('GET', `${this.envPath}/services`);
  }

  restartService(name: string): Promise<void> {
    return this.json('POST', `${this.envPath}/services/${encodeURIComponent(name)}/restart`, { body: {} });
  }

  runSchedule(name: string): Promise<unknown> {
    return this.json('POST', `${this.envPath}/schedules/${encodeURIComponent(name)}/run`, { body: {} });
  }

  async getLogs(q: LogsQuery): Promise<LogEvent[]> {
    const data = await this.json<LogEvent[] | { lines?: LogEvent[]; logs?: LogEvent[] }>('GET', `${this.envPath}/logs`, { query: { ...q } });
    if (Array.isArray(data)) return data;
    return data.lines ?? data.logs ?? [];
  }

  searchLogs(q: LogSearch): Promise<LogLine[]> {
    return this.json('GET', `${this.envPath}/logs/search`, { query: { ...q } });
  }

  deploymentTimeline(n: number): Promise<Timeline> {
    return this.json('GET', `${this.envPath}/deployments/${n}/timeline`);
  }

  listVars(): Promise<LiveVariable[]> {
    return this.json('GET', `${this.envPath}/vars`);
  }

  listSchedules(): Promise<ScheduleInfo[]> {
    return this.json('GET', `${this.envPath}/schedules`);
  }

  listVolumes(): Promise<VolumeInfo[]> {
    return this.json('GET', `${this.envPath}/volumes`);
  }

  /** A directory listing (JSON) or, for a file, the response whose body is its bytes. */
  async volumeGet(volume: string, path: string): Promise<{ listing: VolumeListing } | { file: Response }> {
    const res = await this.request('GET', `${this.envPath}/volumes/${encodeURIComponent(volume)}/files`, { query: { path }, accept: 'application/json, application/octet-stream' });
    if ((res.headers.get('content-type') ?? '').startsWith('application/json')) return { listing: (await res.json()) as VolumeListing };
    return { file: res };
  }

  async volumePut(volume: string, path: string, bytes: Buffer, overwrite: boolean): Promise<VolumeWrite> {
    const res = await this.request('PUT', `${this.envPath}/volumes/${encodeURIComponent(volume)}/files`, { query: { path, overwrite: overwrite ? 1 : undefined }, raw: bytes });
    return (await res.json()) as VolumeWrite;
  }

  dbApplied(): Promise<AppliedMigration[]> {
    return this.json('GET', `${this.envPath}/db/applied`);
  }

  dbReset(): Promise<DbReset> {
    return this.json('POST', `${this.envPath}/db/reset`, { body: {} });
  }

  followLogs(q: LogsQuery, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    return this.sse(`${this.envPath}/logs`, { query: { ...q, follow: 1 }, signal });
  }

  getAccess(): Promise<{ access: string; source?: string }> {
    return this.json('GET', `${this.envPath}/access`);
  }

  /** null clears the online override, so boxlite.toml decides again. */
  setAccess(access: string | null): Promise<{ access: string; source?: string }> {
    return this.json('PUT', `${this.envPath}/access`, { body: { access } });
  }

  // Database

  dbInfo(): Promise<DbInfo> {
    return this.json('GET', `${this.envPath}/db`);
  }

  dbSchema(table?: string): Promise<unknown> {
    return this.json('GET', `${this.envPath}/db/schema${table ? `/${encodeURIComponent(table)}` : ''}`);
  }

  dbRows(table: string, q: { where?: string; limit?: number; offset?: number }): Promise<SqlResult | { rows: unknown[] }> {
    return this.json('GET', `${this.envPath}/db/rows/${encodeURIComponent(table)}`, { query: q });
  }

  sql(query: string, opts: { write?: boolean; explain?: boolean }): Promise<SqlResult> {
    return this.json('POST', `${this.envPath}/db/sql`, { body: { query, ...opts } });
  }

  dbMigrations(): Promise<MigrationStatus[]> {
    return this.json('GET', `${this.envPath}/db/migrations`);
  }

  dbSnapshots(): Promise<DbSnapshot[]> {
    return this.json('GET', `${this.envPath}/db/snapshots`);
  }

  createDbSnapshot(message: string): Promise<DbSnapshot> {
    return this.json('POST', `${this.envPath}/db/snapshots`, { body: { message } });
  }

  dbRestore(body: { to?: string; snapshot?: string }): Promise<unknown> {
    return this.json('POST', `${this.envPath}/db/restore`, { body });
  }

  /** Variables for `app dev`; no DATABASE_URL (it goes through the local db proxy), just the database's name. */
  devEnv(): Promise<{ env: Record<string, string>; database?: { name: string } | null }> {
    return this.json('GET', `${this.envPath}/dev-env`);
  }

  /** A WebSocket carrying one Postgres connection (`app db proxy`); `write` logs in as the owner. */
  dbSocket(write: boolean, session: string): WebSocket {
    const url = new URL(`${this.baseUrl}${this.envPath}/db/connect`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (write) url.searchParams.set('write', '1');
    return new WebSocket(url, { headers: { authorization: `Bearer ${this.key}`, 'x-boxlite-proxy-session': session }, ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) });
  }

  /** The export as a streamed response (CSV of one table, or SQL). */
  dbExport(q: { table?: string; format?: string }): Promise<Response> {
    return this.request('GET', `${this.envPath}/db/export`, { query: q, accept: 'text/csv, application/sql, application/json', noRetry: true });
  }

  dbImport(table: string, csv: Readable): Promise<DbImport> {
    return this.json('POST', `${this.envPath}/db/import`, { query: { table }, stream: { body: csv, type: 'text/csv' } });
  }

  // End-user sign-in

  authStatus(): Promise<AuthStatus> {
    return this.json('GET', `${this.envPath}/auth`);
  }

  authRedirectUris(): Promise<{ provider: string; redirect_uri: string; status: string }[]> {
    return this.json('GET', `${this.envPath}/auth/redirect-uris`);
  }

  authUsers(search?: string): Promise<AuthUser[]> {
    return this.json('GET', `${this.envPath}/auth/users`, { query: { search } });
  }

  authUserAction(id: string, action: 'signout' | 'block' | 'unblock'): Promise<AuthUser & { revoked?: number }> {
    return this.json('POST', `${this.envPath}/auth/users/${encodeURIComponent(id)}/${action}`, { body: {} });
  }

  async authUsersCsv(): Promise<string> {
    return (await this.request('GET', `${this.envPath}/auth/users/export`, { accept: 'text/csv' })).text();
  }

  createTestSession(email: string): Promise<TestSession> {
    return this.json('POST', `${this.envPath}/auth/test-sessions`, { body: { email } });
  }
}

export interface AuthStatus {
  enabled: boolean;
  providers: { name: string; status: 'ready' | 'not_configured' | string }[];
  protect: string[];
  login_url: string;
  users: number;
}

export interface AuthUser {
  id: string;
  email: string | null;
  name: string | null;
  provider: string;
  first_seen?: string;
  last_seen?: string;
  blocked: boolean;
  active_sessions?: number;
}

export interface TestSession {
  cookie: string;
  cookie_name?: string;
  expires_in: string;
  expires_at?: string;
  user?: AuthUser;
}

export interface WhoAmI {
  app: string;
  actor: string;
  key: { last4: string; created_at: string } | null;
  scope: string;
  environments: { name: string; status: string; url: string }[];
  control_plane: string;
  cli: { latest_version: string | null; download_url: string };
}

export interface CliVersion {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  updated_at: string;
}

export interface Probe {
  url: string;
  path: string;
  status: number | null;
  ok: boolean;
  ms: number;
  starting: boolean;
  reason: 'ok' | 'not_deployed' | 'starting' | 'http_error' | 'unreachable';
  content_type: string | null;
  body_head: string;
}

export interface TimelineStep {
  name: string;
  status: string;
  detail?: string;
  ms?: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface Timeline {
  deployment: Deployment;
  steps: TimelineStep[];
  logs: LogLine[];
  truncated: boolean;
}

export interface LiveVariable {
  name: string;
  value: string | null;
  secret: boolean;
  source: string;
  resolved: boolean;
}

export interface ScheduleInfo {
  name: string;
  cron: string;
  target: string;
  next_run: string | null;
  last_run: string | null;
  last_status: number | null;
}

export interface VolumeInfo {
  name: string;
  mount: string;
  mode: string;
}

export interface VolumeEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mode: string;
  modified_at: string;
}

export interface VolumeListing {
  volume: string;
  path: string;
  type: 'dir';
  entries: VolumeEntry[];
}

export interface VolumeWrite {
  volume: string;
  path: string;
  bytes: number;
  replaced: boolean;
}

export interface AppliedMigration {
  file: string;
  sha256: string;
  deployment: number | null;
  applied_at: string;
}

export interface DbReset {
  reset: string;
  dropped_tables: string[];
  snapshot: string;
}

export function eventData<T>(ev: SseEvent): T | undefined {
  return parseJsonData<T>(ev);
}

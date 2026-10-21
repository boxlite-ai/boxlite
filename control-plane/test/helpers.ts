import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase, AppliedRow, QueryResult } from '../src/appdb.js';
import type { BoxInfo, BoxliteClient, CreateBoxRequest, VolumeInfo } from '../src/boxlite.js';
import type { Config } from '../src/config.js';
import type { Ctx } from '../src/ctx.js';
import type { MigrationFile } from '../src/db.js';
import type { NeonBranch, NeonClient, NeonProject } from '../src/neon.js';
import type { SupervisorStatus } from '../src/orchestrator.js';
import { UpstreamError } from '../src/errors.js';
import { deriveOriginUrl } from '../src/origins.js';
import { buildCtx, createServer } from '../src/server.js';
import type { SupervisorClient, SupervisorHealth } from '../src/supervisor.js';

export const ADMIN = 'test-admin-token';

export class FakeBoxlite implements BoxliteClient {
  boxes = new Map<string, BoxInfo & { req: CreateBoxRequest }>();
  volumes: VolumeInfo[] = [];
  calls: string[] = [];
  tunnelUrl = 'https://8080-fake.proxy.test';
  private n = 0;

  async createBox(req: CreateBoxRequest): Promise<BoxInfo> {
    this.calls.push(`create ${req.name}`);
    const id = `box${++this.n}`;
    const box = { id, name: req.name, status: 'running', req };
    this.boxes.set(id, box);
    return { id, name: req.name, status: 'running' };
  }
  async getBox(id: string): Promise<BoxInfo | null> {
    const b = this.boxes.get(id);
    return b ? { id: b.id, name: b.name, status: b.status } : null;
  }
  async startBox(id: string): Promise<void> {
    this.calls.push(`start ${id}`);
    const b = this.boxes.get(id);
    if (b) b.status = 'running';
  }
  async stopBox(id: string): Promise<void> {
    this.calls.push(`stop ${id}`);
    const b = this.boxes.get(id);
    if (b) b.status = 'stopped';
  }
  async deleteBox(id: string): Promise<void> {
    this.calls.push(`delete ${id}`);
    this.boxes.delete(id);
  }
  async tunnel(id: string, port: number): Promise<string> {
    this.calls.push(`tunnel ${id} ${port}`);
    return this.tunnelUrl;
  }
  async createVolume(name: string): Promise<VolumeInfo> {
    const v = { id: `vol${this.volumes.length + 1}`, name };
    this.volumes.push(v);
    return v;
  }
  async listVolumes(): Promise<VolumeInfo[]> {
    return [...this.volumes];
  }
  async deleteVolume(id: string): Promise<void> {
    this.volumes = this.volumes.filter((v) => v.id !== id);
  }
}

export class FakeNeon implements NeonClient {
  calls: string[] = [];
  async createProject(name: string): Promise<NeonProject> {
    this.calls.push(`project ${name}`);
    return { projectId: 'proj-1', mainBranchId: 'br-main', host: 'ep-main.neon.test', connectionUri: 'postgresql://neondb_owner:pw@ep-main.neon.test/neondb' };
  }
  async deleteProject(): Promise<void> {}
  async createBranch(_p: string, name: string, parentId: string | null, init: string): Promise<NeonBranch> {
    this.calls.push(`branch ${name} ${parentId} ${init}`);
    return { branchId: `br-${name}`, logicalSizeBytes: 0 };
  }
  async deleteBranch(_p: string, b: string): Promise<void> {
    this.calls.push(`delete-branch ${b}`);
  }
  async getBranch(_p: string, b: string): Promise<NeonBranch> {
    return { branchId: b, logicalSizeBytes: 1234 };
  }
  async connectionUri(_p: string, b: string): Promise<string> {
    return `postgresql://neondb_owner:pw@ep-${b}.neon.test/neondb`;
  }
  async restoreBranch(_p: string, b: string, ts: string, preserve: string): Promise<void> {
    this.calls.push(`restore ${b} ${ts} ${preserve}`);
  }
  /** branch → role name → {authMethod, password}. `no_login` = created by SQL. */
  roles = new Map<string, Map<string, { authMethod: string; password: string }>>();
  branches = ['br-main'];
  private rolesOf(b: string) {
    let m = this.roles.get(b);
    if (!m) this.roles.set(b, (m = new Map()));
    return m;
  }
  async listBranches(): Promise<{ id: string; name: string }[]> {
    this.calls.push('list-branches');
    return this.branches.map((id) => ({ id, name: id }));
  }
  async getRole(_p: string, b: string, name: string): Promise<{ name: string; authMethod: string } | null> {
    const r = this.rolesOf(b).get(name);
    return r ? { name, authMethod: r.authMethod } : null;
  }
  async createRole(_p: string, b: string, name: string): Promise<'created' | 'exists'> {
    this.calls.push(`create-role ${b} ${name}`);
    if (this.rolesOf(b).has(name)) return 'exists';
    this.rolesOf(b).set(name, { authMethod: 'password', password: `pw-${b}` });
    return 'created';
  }
  async deleteRole(_p: string, b: string, name: string): Promise<void> {
    this.calls.push(`delete-role ${b} ${name}`);
    this.rolesOf(b).delete(name);
  }
  async revealRolePassword(_p: string, b: string, name: string): Promise<string> {
    const r = this.rolesOf(b).get(name);
    if (!r) throw new UpstreamError('neon', 404, 'role not found');
    return r.password;
  }
}

/**
 * Plays the supervisor: answers the gateway calls and reports status back to the orchestrator the
 * way the real one does over POST /sv/v1/status.
 */
export class FakeSupervisor implements SupervisorClient {
  calls: string[] = [];
  failBuild = false;
  failStart = false;
  /** Answer this many deploy calls with 409 deploy_in_progress first. */
  busy = 0;
  /** Answer this many health probes with 403 (no gateway secret yet). */
  forbiddenHealth = 0;
  /** The wire protocol health reports (SUPERVISOR_PROTOCOL is 2). */
  version = 2;
  /** The secret each control call carried, in order. */
  secrets: string[] = [];
  ctx!: Ctx;

  private report(release: number, phase: SupervisorStatus['phase'], extra: Partial<SupervisorStatus> = {}) {
    setTimeout(() => {
      const env = this.ctx.store.all<{ id: string }>('SELECT id FROM envs WHERE box_id IS NOT NULL').map((e) => this.ctx.store.envById(e.id)!)[0]!;
      this.ctx.orchestrator.onLogs(env, [{ ts: new Date().toISOString(), source: 'build', level: 'info', line: `${phase} ${release}`, deployment: release }]);
      this.ctx.orchestrator.onSupervisorStatus(env, { deployment: release, phase, ...extra });
    }, 5);
  }

  async health(_u?: string, secret?: string): Promise<SupervisorHealth> {
    this.calls.push('health');
    if (secret !== undefined) this.secrets.push(secret);
    if (this.forbiddenHealth > 0) {
      this.forbiddenHealth--;
      throw new UpstreamError('supervisor', 403, 'GET /.boxlite/sv/health → 403', '{"error":"gateway"}');
    }
    return { version: this.version, root: true, sudo_locked: true, ok: true, deployment: null, services: [] };
  }
  async deploy(_u: string, s: string, n: number): Promise<void> {
    this.calls.push(`deploy ${n}`);
    this.secrets.push(s);
    if (this.busy > 0) {
      this.busy--;
      throw new UpstreamError('supervisor', 409, 'POST /.boxlite/sv/deploy → 409', '{"error":"deploy_in_progress"}');
    }
    this.report(n, 'building');
    if (this.failBuild) this.report(n, 'failed', { step: 'build', error: 'npm ci exited with 1', log_tail: ['npm ERR! missing script'] });
    else this.report(n, 'built');
  }
  private live(n: number) {
    this.report(n, 'starting');
    if (this.failStart) this.report(n, 'failed', { step: 'start', error: 'service web failed its health check' });
    else this.report(n, 'live', { services: [{ name: 'web', state: 'running', health: 'healthy', port: 3000 }] });
  }
  async activate(_u: string, _s: string, n: number): Promise<void> {
    this.calls.push(`activate ${n}`);
    this.live(n);
  }
  async rollback(_u: string, _s: string, n: number): Promise<void> {
    this.calls.push(`rollback ${n}`);
    this.live(n);
  }
  async restart(): Promise<void> {}
  async logs(): Promise<unknown> {
    return { lines: [] };
  }
}

export class FakeAppDb implements AppDatabase {
  applied: AppliedRow[] = [];
  queries: { statements: string[]; write: boolean }[] = [];
  readers: string[] = [];
  async ensureReader(url: string): Promise<void> {
    this.readers.push(url);
  }
  async listApplied(): Promise<AppliedRow[]> {
    return [...this.applied];
  }
  async applyMigration(_u: string, m: MigrationFile, deployment: number): Promise<void> {
    this.applied.push({ file: m.file, sha256: m.sha256, deployment, applied_at: new Date().toISOString() });
  }
  async query(_u: string, statements: string[], opts: { write: boolean }): Promise<QueryResult> {
    this.queries.push({ statements, write: opts.write });
    return { columns: ['x'], rows: [[1]], row_count: 1, truncated: false, elapsed_ms: 1 };
  }
}

export interface Harness {
  ctx: Ctx;
  app: ReturnType<typeof createServer>;
  boxlite: FakeBoxlite;
  neon: FakeNeon;
  supervisor: FakeSupervisor;
  appdb: FakeAppDb;
  dir: string;
  /**
   * A request as if it arrived on `port`. Without one: `/console…` paths go to the console origin,
   * everything else to the API origin.
   */
  request(path: string, init?: RequestInit & { key?: string; json?: unknown; port?: number }): Promise<Response>;
  /** The env's origin port (allocated on first use) and URL. */
  appPort(app?: string, env?: string): number;
  appUrl(app?: string, env?: string): string;
  /** A request on the env's own origin. */
  appRequest(path: string, init?: RequestInit & { key?: string; json?: unknown }, app?: string, env?: string): Promise<Response>;
  /** Ports the CP asked BoxLite to tunnel. */
  tunnels: number[];
  close(): void;
}

export const API_PORT = 8080;
export const CONSOLE_PORT = 8081;

export function harness(overrides: Partial<Config> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cp-test-'));
  const config: Config = {
    port: API_PORT,
    consolePort: CONSOLE_PORT,
    publicUrl: 'https://cp.test',
    dataDir: dir,
    adminToken: ADMIN,
    sessionSecret: 'test-session-secret',
    boxliteApiUrl: 'https://boxlite.invalid/v1',
    boxliteApiKey: 'x',
    neonApiKey: 'x',
    neonOrgId: 'org',
    neonRegion: 'aws-us-east-2',
    svBinDir: join(dir, 'bin'),
    agentMdPath: join(dir, 'SKILL.md'),
    cliTgzPath: join(dir, 'cli.tgz'),
    ...overrides,
  };
  const boxlite = new FakeBoxlite();
  const neon = new FakeNeon();
  const supervisor = new FakeSupervisor();
  const appdb = new FakeAppDb();
  const tunnels: number[] = [];
  // Like BoxLite: a tunnel to CP Box port p is https://<p>-<host of the API origin>.
  const registerTunnel = async (p: number) => {
    tunnels.push(p);
    return deriveOriginUrl(config.publicUrl, p);
  };
  const ctx = buildCtx(config, { boxlite, neon, supervisor, appdb, registerTunnel }, { supervisorReadyMs: 1000, buildMs: 2000, activateMs: 2000, pollMs: 10 });
  supervisor.ctx = ctx;
  const app = createServer(ctx);
  const envRow = (a: string, e: string) => {
    const row = ctx.store.appByNameAnyState(a);
    const env = row ? ctx.store.envByName(row.id, e) : undefined;
    if (!env) throw new Error(`no env ${a}/${e}`);
    return env;
  };
  const request: Harness['request'] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const port = init.port ?? (path === '/console' || path.startsWith('/console/') ? ctx.origins.consolePort : ctx.origins.apiPort);
    return Promise.resolve(app.request(path, { ...init, headers, body }, { localPort: port }));
  };
  return {
    tunnels,
    appPort: (a = 'crm', e = 'main') => ctx.origins.portOf(envRow(a, e).id),
    appUrl: (a = 'crm', e = 'main') => ctx.resources.appUrl(a, e),
    appRequest: (path, init = {}, a = 'crm', e = 'main') => request(path, { ...init, port: ctx.origins.portOf(envRow(a, e).id) }),
    ctx,
    app,
    boxlite,
    neon,
    supervisor,
    appdb,
    dir,
    request,
    close() {
      ctx.scheduler.stop();
      ctx.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export async function createApp(h: Harness, name = 'crm'): Promise<string> {
  const res = await h.request('/v1/apps', { method: 'POST', key: ADMIN, json: { name } });
  if (res.status !== 201) throw new Error(`create app: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { key: string }).key;
}

export const TOML = `name = "crm"

[runtime]
image = "node"
size = "small"
build = ["npm ci"]

[[service]]
name = "web"
command = "node server.js"
port = 3000
health = "/healthz"
`;

/** Uploads `files` and returns the snapshot id. */
export async function upload(h: Harness, key: string, files: Record<string, string>): Promise<string> {
  const manifest = Object.entries(files).map(([path, content]) => ({ path, size: Buffer.byteLength(content), mode: 0o644, sha256: sha(content) }));
  const res = await h.request('/v1/apps/crm/uploads', { method: 'POST', key, json: { manifest } });
  const up = (await res.json()) as { upload_id: string; missing: string[] };
  for (const [, content] of Object.entries(files)) {
    if (!up.missing.includes(sha(content))) continue;
    await h.request(`/v1/apps/crm/uploads/${up.upload_id}/files/${sha(content)}`, { method: 'PUT', key, body: content, headers: { 'content-type': 'application/octet-stream' } });
  }
  const done = await h.request(`/v1/apps/crm/uploads/${up.upload_id}/complete`, { method: 'POST', key });
  if (done.status !== 200) throw new Error(`complete: ${done.status} ${await done.text()}`);
  return ((await done.json()) as { snapshot_id: string }).snapshot_id;
}

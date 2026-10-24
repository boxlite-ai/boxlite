import { UpstreamError, fail } from './errors.js';
import { requestJson, sleep } from './http.js';

export interface NeonProject {
  projectId: string;
  mainBranchId: string;
  host: string;
  /** Connection URI of the main branch, password included. */
  connectionUri: string;
}

export interface NeonBranch {
  branchId: string;
  logicalSizeBytes: number | null;
}

/** The slice of the Neon v2 API the CP uses. Injected so tests run against a fake. */
export interface NeonClient {
  createProject(name: string): Promise<NeonProject>;
  deleteProject(projectId: string): Promise<void>;
  createBranch(projectId: string, name: string, parentId: string | null, initSource: 'schema-only' | 'parent-data'): Promise<NeonBranch>;
  deleteBranch(projectId: string, branchId: string): Promise<void>;
  getBranch(projectId: string, branchId: string): Promise<NeonBranch>;
  connectionUri(projectId: string, branchId: string): Promise<string>;
  /** Point-in-time restore of a branch onto its own history; the pre-restore state is kept as `preserveUnderName`. */
  restoreBranch(projectId: string, branchId: string, timestamp: string, preserveUnderName: string): Promise<void>;
  listBranches(projectId: string): Promise<{ id: string; name: string }[]>;
  /** A Postgres role managed by Neon (console/API). `authMethod` is `no_login` for roles created by SQL. */
  getRole(projectId: string, branchId: string, name: string): Promise<{ name: string; authMethod: string } | null>;
  /** Creates the role through the API and waits until it is applied; `exists` when it already was. */
  createRole(projectId: string, branchId: string, name: string): Promise<'created' | 'exists'>;
  deleteRole(projectId: string, branchId: string, name: string): Promise<void>;
  /** The role's password. A secret: callers must never log or return it. */
  revealRolePassword(projectId: string, branchId: string, name: string): Promise<string>;
}

const DATABASE = 'neondb';
const ROLE = 'neondb_owner';

/**
 * Say sslmode=verify-full explicitly. Neon serves publicly trusted certificates, and node-postgres
 * treats `require` as verify-full while printing a deprecation warning into every app's logs.
 */
export function withSslmode(uri: string): string {
  const u = new URL(uri);
  const mode = u.searchParams.get('sslmode');
  if (!mode || mode === 'require') u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
}

export function hostOf(uri: string): string {
  return new URL(uri).hostname;
}

/** One Neon call, retries included, gives up after this: calls run inside request handlers and deploy steps. */
const CALL_DEADLINE_MS = 90_000;
const ATTEMPT_TIMEOUT_MS = 60_000;

export class HttpNeonClient implements NeonClient {
  constructor(
    private readonly apiKey: string,
    private readonly orgId: string,
    private readonly region = 'aws-us-east-2',
    private readonly base = 'https://console.neon.tech/api/v2',
  ) {}

  /**
   * Neon runs project/branch changes as async operations and answers 423 Locked while one is in
   * flight. Retrying the next call with backoff is simpler than polling /operations and has the
   * same effect. A POST that failed in flight (timeout, 5xx) may still have happened, so only
   * 423 and 429 (nothing ran) are retried for it; creates then look for what they made by name.
   */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw fail('unavailable', 'NEON_API_KEY is not configured on the control plane', 'this platform has no database service configured, and nothing in the app can change that: remove [database] from boxlite.toml, or tell the user the platform operator must set NEON_API_KEY');
    const idempotent = method === 'GET' || method === 'DELETE';
    const deadline = Date.now() + CALL_DEADLINE_MS;
    let delay = 500;
    for (;;) {
      try {
        const { body: out } = await requestJson<T>('database service', {
          method,
          url: `${this.base}${path}`,
          headers: { authorization: `Bearer ${this.apiKey}` },
          body,
          timeoutMs: Math.max(1_000, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now())),
        });
        return out;
      } catch (err) {
        const status = err instanceof UpstreamError ? err.status : -1;
        const retryable = status === 423 || status === 429 || (idempotent && (status >= 500 || status === 0));
        if (!retryable || Date.now() + delay >= deadline) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  /** A create whose answer was lost (timeout, 5xx) or that collides with such an earlier one (409). */
  private static maybeCreated(err: unknown): boolean {
    return err instanceof UpstreamError && (err.status === 0 || err.status >= 500 || err.status === 409);
  }

  async createProject(name: string): Promise<NeonProject> {
    if (!this.orgId) throw fail('unavailable', 'NEON_ORG_ID is not configured on the control plane', 'this platform has no database service configured, and nothing in the app can change that: remove [database] from boxlite.toml, or tell the user the platform operator must set NEON_ORG_ID');
    // The create response carries the default branch as `branch` (singular).
    let out: { project: { id: string }; branch?: { id: string }; branches?: { id: string }[]; connection_uris: { connection_uri: string }[] };
    try {
      out = await this.call('POST', '/projects', { project: { name, org_id: this.orgId, region_id: this.region, pg_version: 17 } });
    } catch (err) {
      const existing = HttpNeonClient.maybeCreated(err) ? await this.findProject(name) : null;
      if (!existing) throw err;
      return existing;
    }
    const main = out.branch ?? out.branches?.[0];
    const uri = out.connection_uris[0]?.connection_uri;
    if (!main || !uri) throw new UpstreamError('database service', 201, 'project create returned no branch or connection URI');
    return { projectId: out.project.id, mainBranchId: main.id, host: hostOf(uri), connectionUri: uri };
  }

  /** The org's project of that name, as createProject returns it; null when there is none. */
  private async findProject(name: string): Promise<NeonProject | null> {
    const q = new URLSearchParams({ org_id: this.orgId, search: name });
    const { projects } = await this.call<{ projects: { id: string; name: string }[] }>('GET', `/projects?${q}`);
    const project = projects.find((p) => p.name === name);
    if (!project) return null;
    const { branches } = await this.call<{ branches: { id: string; default?: boolean }[] }>('GET', `/projects/${project.id}/branches`);
    const main = branches.find((b) => b.default) ?? branches[0];
    if (!main) return null;
    const uri = await this.connectionUri(project.id, main.id);
    return { projectId: project.id, mainBranchId: main.id, host: hostOf(uri), connectionUri: uri };
  }

  async deleteProject(projectId: string): Promise<void> {
    try {
      await this.call('DELETE', `/projects/${projectId}`);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return;
      throw err;
    }
  }

  async createBranch(projectId: string, name: string, parentId: string | null, initSource: 'schema-only' | 'parent-data'): Promise<NeonBranch> {
    const branch: Record<string, string> = { name, init_source: initSource };
    if (parentId) branch.parent_id = parentId;
    try {
      const out = await this.call<{ branch: { id: string; logical_size?: number } }>('POST', `/projects/${projectId}/branches`, {
        branch,
        endpoints: [{ type: 'read_write' }],
      });
      return { branchId: out.branch.id, logicalSizeBytes: out.branch.logical_size ?? null };
    } catch (err) {
      const existing = HttpNeonClient.maybeCreated(err) ? (await this.listBranches(projectId)).find((b) => b.name === name) : undefined;
      if (!existing) throw err;
      return { branchId: existing.id, logicalSizeBytes: null };
    }
  }

  async deleteBranch(projectId: string, branchId: string): Promise<void> {
    try {
      await this.call('DELETE', `/projects/${projectId}/branches/${branchId}`);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return;
      throw err;
    }
  }

  async getBranch(projectId: string, branchId: string): Promise<NeonBranch> {
    const out = await this.call<{ branch: { id: string; logical_size?: number } }>('GET', `/projects/${projectId}/branches/${branchId}`);
    return { branchId: out.branch.id, logicalSizeBytes: out.branch.logical_size ?? null };
  }

  async connectionUri(projectId: string, branchId: string): Promise<string> {
    const q = new URLSearchParams({ branch_id: branchId, database_name: DATABASE, role_name: ROLE });
    const out = await this.call<{ uri: string }>('GET', `/projects/${projectId}/connection_uri?${q}`);
    return out.uri;
  }

  async listBranches(projectId: string): Promise<{ id: string; name: string }[]> {
    const out = await this.call<{ branches: { id: string; name: string }[] }>('GET', `/projects/${projectId}/branches`);
    return out.branches.map((b) => ({ id: b.id, name: b.name }));
  }

  async getRole(projectId: string, branchId: string, name: string): Promise<{ name: string; authMethod: string } | null> {
    try {
      const out = await this.call<{ role: { name: string; authentication_method?: string } }>('GET', `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(name)}`);
      return { name: out.role.name, authMethod: out.role.authentication_method ?? 'password' };
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return null;
      throw err;
    }
  }

  async createRole(projectId: string, branchId: string, name: string): Promise<'created' | 'exists'> {
    try {
      const out = await this.call<{ operations?: { id: string }[] }>('POST', `/projects/${projectId}/branches/${branchId}/roles`, { role: { name } });
      await this.waitOperations(projectId, out.operations ?? []);
      return 'created';
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 409) return 'exists';
      throw err;
    }
  }

  async deleteRole(projectId: string, branchId: string, name: string): Promise<void> {
    try {
      const out = await this.call<{ operations?: { id: string }[] }>('DELETE', `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(name)}`);
      await this.waitOperations(projectId, out.operations ?? []);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return;
      throw err;
    }
  }

  async revealRolePassword(projectId: string, branchId: string, name: string): Promise<string> {
    const out = await this.call<{ password: string }>('GET', `/projects/${projectId}/branches/${branchId}/roles/${encodeURIComponent(name)}/reveal_password`);
    return out.password;
  }

  /** Role changes are applied to the compute asynchronously; SQL that depends on them must wait. */
  private async waitOperations(projectId: string, ops: { id: string }[]): Promise<void> {
    for (const op of ops) {
      for (let i = 0; ; i++) {
        const { operation } = await this.call<{ operation: { status: string; error?: string } }>('GET', `/projects/${projectId}/operations/${op.id}`);
        if (operation.status === 'finished' || operation.status === 'skipped') break;
        if (['failed', 'error', 'cancelled'].includes(operation.status)) throw new UpstreamError('database service', 500, `operation ${op.id} ${operation.status}: ${operation.error ?? ''}`);
        if (i > 120) throw new UpstreamError('database service', 504, `operation ${op.id} still ${operation.status} after 60 s`);
        await sleep(500);
      }
    }
  }

  async restoreBranch(projectId: string, branchId: string, timestamp: string, preserveUnderName: string): Promise<void> {
    // Shape checked against the Neon API reference (BranchRestoreRequest) on 2026-10-21:
    // restoring a branch onto its own history needs source_timestamp (or source_lsn) and
    // preserve_under_name. Not yet exercised against the live API by this prototype.
    await this.call('POST', `/projects/${projectId}/branches/${branchId}/restore`, {
      source_branch_id: branchId,
      source_timestamp: timestamp,
      preserve_under_name: preserveUnderName,
    });
  }
}

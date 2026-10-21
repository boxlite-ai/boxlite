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

export class HttpNeonClient implements NeonClient {
  private readonly base = 'https://console.neon.tech/api/v2';

  constructor(
    private readonly apiKey: string,
    private readonly orgId: string,
    private readonly region = 'aws-us-east-2',
  ) {}

  /**
   * Neon runs project/branch changes as async operations and answers 423 Locked while one is in
   * flight. Retrying the next call with backoff is simpler than polling /operations and has the
   * same effect.
   */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw fail('unavailable', 'NEON_API_KEY is not configured on the control plane', 'set NEON_API_KEY and restart the control plane');
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      try {
        const { body: out } = await requestJson<T>('neon', {
          method,
          url: `${this.base}${path}`,
          headers: { authorization: `Bearer ${this.apiKey}` },
          body,
          timeoutMs: 60_000,
        });
        return out;
      } catch (err) {
        const retryable = err instanceof UpstreamError && (err.status === 423 || err.status === 429 || err.status >= 500 || err.status === 0);
        if (!retryable || attempt >= 12) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  async createProject(name: string): Promise<NeonProject> {
    if (!this.orgId) throw fail('unavailable', 'NEON_ORG_ID is not configured on the control plane', 'set NEON_ORG_ID and restart the control plane');
    // The create response carries the default branch as `branch` (singular).
    const out = await this.call<{
      project: { id: string };
      branch?: { id: string };
      branches?: { id: string }[];
      connection_uris: { connection_uri: string }[];
    }>('POST', '/projects', { project: { name, org_id: this.orgId, region_id: this.region, pg_version: 17 } });
    const main = out.branch ?? out.branches?.[0];
    const uri = out.connection_uris[0]?.connection_uri;
    if (!main || !uri) throw new UpstreamError('neon', 201, 'project create returned no branch or connection URI');
    return { projectId: out.project.id, mainBranchId: main.id, host: hostOf(uri), connectionUri: uri };
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
    const out = await this.call<{ branch: { id: string; logical_size?: number } }>('POST', `/projects/${projectId}/branches`, {
      branch,
      endpoints: [{ type: 'read_write' }],
    });
    return { branchId: out.branch.id, logicalSizeBytes: out.branch.logical_size ?? null };
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

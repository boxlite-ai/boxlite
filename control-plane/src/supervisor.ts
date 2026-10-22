import type { EnvRow } from './db.js';
import { requestJson } from './http.js';

export interface ServiceState {
  name: string;
  state: string;
  pid?: number | null;
  restarts?: number;
  last_exit_code?: number | null;
  health?: string;
  port?: number | null;
}

/** What the supervisor reports on POST /sv/v1/status. */
export interface SupervisorStatus {
  deployment: number;
  phase: 'building' | 'built' | 'starting' | 'live' | 'failed';
  step?: string;
  error?: string;
  log_tail?: string[];
  services?: ServiceState[];
}

export interface SupervisorHealth {
  /** Wire protocol (contracts §2.3); see SUPERVISOR_PROTOCOL. */
  version?: number;
  build?: string;
  /** The supervisor runs as root and app code as boxlite (§2.1). */
  root?: boolean;
  /** boxlite's sudo is limited to the launcher (§2.1). */
  sudo_locked?: boolean;
  ok: boolean;
  deployment: number | null;
  spec_version?: number | null;
  services: ServiceState[];
}

/**
 * The two credentials of an app Box's gateway (security review F3). They never travel together:
 *
 * - forwarding: `X-BoxLite-Gateway: <forward_secret>` on every end-user request the proxy forwards.
 *   It only lets traffic through to the app; the gateway refuses it on `/.boxlite/sv/*`.
 * - control: `X-BoxLite-Control: <control_secret>` on the CP's own `/.boxlite/sv/*` calls. It never
 *   reaches the app.
 *
 * Every caller builds its headers here, so neither secret can end up on the wrong kind of request.
 */
const FORWARD_HEADER = 'x-boxlite-gateway';
const CONTROL_HEADER = 'x-boxlite-control';

export function forwardHeaders(env: Pick<EnvRow, 'forward_secret'>): Record<string, string> {
  return { [FORWARD_HEADER]: env.forward_secret };
}

export function controlHeaders(env: Pick<EnvRow, 'control_secret'>): Record<string, string> {
  return controlHeader(env.control_secret);
}

function controlHeader(secret: string): Record<string, string> {
  return { [CONTROL_HEADER]: secret };
}

/**
 * CP → supervisor calls (contracts §2.3), made through the Box's public tunnel. `secret` is the
 * env's control secret (`env.control_secret`); the gateway refuses control calls without it.
 */
export interface SupervisorClient {
  health(boxUrl: string, secret: string): Promise<SupervisorHealth>;
  /** Fetch + extract + build release N, then report `built`; the old release keeps serving. */
  deploy(boxUrl: string, secret: string, release: number): Promise<void>;
  /** Start release N's services, health-gate, flip traffic; reports `starting` then `live|failed`. */
  activate(boxUrl: string, secret: string, release: number): Promise<void>;
  /** Re-start onto an existing release dir (no build); same health gate as activate. */
  rollback(boxUrl: string, secret: string, release: number): Promise<void>;
  restart(boxUrl: string, secret: string, service: string | null): Promise<void>;
  logs(boxUrl: string, secret: string, source: string | null, tail: number): Promise<unknown>;
}

export class HttpSupervisorClient implements SupervisorClient {
  async health(boxUrl: string, secret: string): Promise<SupervisorHealth> {
    const { body } = await requestJson<SupervisorHealth>('supervisor', { method: 'GET', url: `${boxUrl}/.boxlite/sv/health`, headers: controlHeader(secret), timeoutMs: 10_000 });
    return body;
  }

  async deploy(boxUrl: string, secret: string, release: number): Promise<void> {
    await requestJson('supervisor', { method: 'POST', url: `${boxUrl}/.boxlite/sv/deploy`, headers: controlHeader(secret), body: { deployment: release }, timeoutMs: 30_000 });
  }

  async activate(boxUrl: string, secret: string, release: number): Promise<void> {
    await requestJson('supervisor', { method: 'POST', url: `${boxUrl}/.boxlite/sv/activate`, headers: controlHeader(secret), body: { deployment: release }, timeoutMs: 30_000 });
  }

  async rollback(boxUrl: string, secret: string, release: number): Promise<void> {
    await requestJson('supervisor', { method: 'POST', url: `${boxUrl}/.boxlite/sv/rollback`, headers: controlHeader(secret), body: { deployment: release }, timeoutMs: 30_000 });
  }

  async restart(boxUrl: string, secret: string, service: string | null): Promise<void> {
    await requestJson('supervisor', { method: 'POST', url: `${boxUrl}/.boxlite/sv/restart`, headers: controlHeader(secret), body: { service }, timeoutMs: 30_000 });
  }

  async logs(boxUrl: string, secret: string, source: string | null, tail: number): Promise<unknown> {
    const q = new URLSearchParams({ tail: String(tail) });
    if (source) q.set('source', source);
    const { body } = await requestJson('supervisor', { method: 'GET', url: `${boxUrl}/.boxlite/sv/logs?${q}`, headers: controlHeader(secret), timeoutMs: 15_000 });
    return body;
  }
}

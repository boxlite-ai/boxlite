import type { Command } from 'commander';

/**
 * Machine-facing facts about a command that commander does not model: the shape of its `--json`
 * output and the exit codes it can return. `scripts/gen-reference.ts` reads these to write
 * docs/cli-reference.md, so the reference cannot drift from the definitions.
 */
export interface CommandMeta {
  /** TypeScript-like shape of the JSON document printed on success. */
  json: string;
  /** Exit codes besides 0 and 1 this command can return. */
  exits?: number[];
  /** Asks for --yes and fails with confirmation_required (exit 10) without it in --json mode. */
  destructive?: boolean;
  /** Example invocations. */
  examples?: string[];
  /** Talks to the control plane (false = purely local). */
  online?: boolean;
}

const metas = new WeakMap<Command, CommandMeta>();

export function describe(cmd: Command, meta: CommandMeta): Command {
  metas.set(cmd, meta);
  return cmd;
}

export function metaOf(cmd: Command): CommandMeta | undefined {
  return metas.get(cmd);
}

/** Shapes referenced by name in the `json` fields above; rendered into the reference's Types section. */
export const SHARED_TYPES: Record<string, string> = {
  EnvSummary: '{ name, status, url, access, spec_version: number | null, latest_deployment: { number, kind, status, message, created_at } | null, live_deployment: { number, kind, release, live_at } | null, box: { id, image, size } | null, database: { branch } | null, from: string | null, created_at }',
  Deployment: '{ number, kind: "deploy"|"apply"|"rollback", status: "queued"|"uploading"|"building"|"migrating"|"starting"|"live"|"failed"|"cancelled"|"superseded"|"rolled_back", message, by, created_at, started_at, finished_at, spec_version, base_version, snapshot_id, release, rollback_to, restore_point, steps: { name, status, ms?, detail? }[], changes, error: { step, message, log_tail? } | null, url, log_tail? }',
  Diagnosis: '{ cause: "missing_lockfile"|"npm_script_missing"|"module_not_found"|"build_timeout"|"build_command_failed"|"port_binding"|"health_404"|"health_failed"|"crash_on_start"|"missing_variable"|"migration_sql_error"|"migration_changed"|"invalid_manifest"|"supervisor_unreachable"|"unknown", summary, fix, file?, line?, evidence: string[] }',
  LogLine: '{ id, ts, source, level: "info"|"error"|…, line, deployment: number | null }',
  AgentContext: '{ app, env, control_plane, generated_at, status, urls: { app, health, login }, access: { level, source }, environments, live, box, runtime, services: { name, exposed, command, static, health_path, state, health, restarts, last_exit_code }[], schedules, database: { status, branch, tables: { name, columns }[], migrations }, volumes, auth, variables: { name, value | null, secret, source, resolved }[], deployments (last 5), recent_errors, next_actions: Finding[], cli: { latest_version } }',
  Finding: '{ id, severity: "error"|"warn"|"info", title, fix, detail?, evidence? }',
};

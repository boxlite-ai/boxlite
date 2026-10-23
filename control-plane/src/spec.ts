import type { CheckError, CheckWarning, Manifest } from '@microcloud/shared';
import type { Change, MigrationFile } from './db.js';
import { BOX_SIZES, IMAGE_REFS, MAX_SNAPSHOT_BYTES, SUPPORTED_AUTH_PROVIDERS } from './platform.js';

export interface AppliedMigration {
  file: string;
  sha256: string;
  deployment: number;
}

export interface Assigned {
  box_id: string | null;
  box_url: string | null;
  db_host: string | null;
  db_branch: string | null;
  app_url: string;
}

/** contracts §0 Spec JSON: the manifest plus platform-assigned values. Immutable once written. */
export interface Spec extends Omit<Manifest, 'database'> {
  version: number;
  deployment: number;
  base_version: number;
  database: { migrations: string; applied: AppliedMigration[] } | null;
  assigned: Assigned;
}

export function buildSpec(args: {
  manifest: Manifest;
  version: number;
  deployment: number;
  baseVersion: number;
  applied: AppliedMigration[];
  assigned: Assigned;
  accessOverride: string | null;
}): Spec {
  const { manifest: m } = args;
  return {
    app: m.app,
    environment: m.environment,
    version: args.version,
    deployment: args.deployment,
    base_version: args.baseVersion,
    runtime: m.runtime,
    services: m.services,
    schedules: m.schedules,
    database: m.database ? { migrations: m.database.migrations, applied: args.applied } : null,
    volumes: m.volumes,
    auth: m.auth,
    domains: m.domains,
    // An online `access` change (PUT /access) wins over the manifest until it is cleared.
    access: (args.accessOverride as Manifest['access'] | null) ?? m.access,
    public_paths: m.public_paths,
    variables: m.variables,
    secrets: m.secrets,
    assigned: args.assigned,
  };
}

/**
 * The part of a Spec that came from boxlite.toml: for comparing with a fresh manifest, and as the
 * base of an online edit (console variables) when the deployment's own manifest is unknown.
 */
export function specToManifest(spec: Spec): Manifest {
  return {
    app: spec.app,
    environment: spec.environment,
    runtime: spec.runtime,
    services: spec.services,
    schedules: spec.schedules,
    database: spec.database ? { migrations: spec.database.migrations } : null,
    volumes: spec.volumes,
    auth: spec.auth,
    domains: spec.domains,
    access: spec.access,
    // Specs from before public_paths existed have none.
    public_paths: spec.public_paths ?? [],
    variables: spec.variables,
    secrets: spec.secrets,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function diffNamed<T extends { name: string }>(prefix: string, from: T[], to: T[], out: Change[]): void {
  const before = new Map(from.map((x) => [x.name, x]));
  const after = new Map(to.map((x) => [x.name, x]));
  for (const [name, b] of before) {
    if (!after.has(name)) out.push({ kind: '-', path: `${prefix}.${name}`, from: b });
  }
  for (const [name, a] of after) {
    const b = before.get(name);
    if (!b) {
      out.push({ kind: '+', path: `${prefix}.${name}`, to: a });
      continue;
    }
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const k of keys) {
      if (k === 'name') continue;
      const fv = (b as Record<string, unknown>)[k];
      const tv = (a as Record<string, unknown>)[k];
      if (!same(fv ?? null, tv ?? null)) out.push({ kind: '~', path: `${prefix}.${name}.${k}`, from: fv ?? null, to: tv ?? null });
    }
  }
}

function diffMap(prefix: string, from: Record<string, string>, to: Record<string, string>, out: Change[]): void {
  for (const k of Object.keys(from)) if (!(k in to)) out.push({ kind: '-', path: `${prefix}.${k}`, from: from[k] });
  for (const [k, v] of Object.entries(to)) {
    if (!(k in from)) out.push({ kind: '+', path: `${prefix}.${k}`, to: v });
    else if (from[k] !== v) out.push({ kind: '~', path: `${prefix}.${k}`, from: from[k], to: v });
  }
}

/**
 * What applying `next` on top of `prev` (the latest Spec, if any) changes.
 * `online_only` marks state that was changed online and that the manifest does not carry: today
 * that is an access level set with PUT /access, which keeps winning over boxlite.toml.
 */
export function diffSpecs(prev: Spec | undefined, next: Manifest, opts: { accessOverride?: string | null; envName?: string } = {}): Change[] {
  const out: Change[] = [];
  const before: Manifest | null = prev ? specToManifest(prev) : null;
  const envName = opts.envName ?? next.environment;

  if (!before) {
    out.push({ kind: '+', path: 'runtime', to: `${next.runtime.image}/${next.runtime.size}` });
  } else {
    for (const k of ['image', 'size', 'build', 'output'] as const) {
      if (!same(before.runtime[k], next.runtime[k])) out.push({ kind: '~', path: `runtime.${k}`, from: before.runtime[k], to: next.runtime[k] });
    }
  }
  diffNamed('service', before?.services ?? [], next.services, out);
  diffNamed('schedule', before?.schedules ?? [], next.schedules, out);
  diffNamed('volume', before?.volumes ?? [], next.volumes, out);

  const db0 = before?.database ?? null;
  const db1 = next.database;
  if (!db0 && db1) out.push({ kind: '+', path: 'database', to: `database for ${envName}` });
  else if (db0 && !db1) out.push({ kind: '-', path: 'database', from: `database for ${envName}` });
  else if (db0 && db1 && db0.migrations !== db1.migrations) out.push({ kind: '~', path: 'database.migrations', from: db0.migrations, to: db1.migrations });

  if (!same(before?.auth ?? null, next.auth)) {
    out.push({ kind: !before?.auth ? '+' : !next.auth ? '-' : '~', path: 'auth', from: before?.auth ?? null, to: next.auth });
  }
  if (!same(before?.domains.custom ?? [], next.domains.custom)) out.push({ kind: '~', path: 'domains.custom', from: before?.domains.custom ?? [], to: next.domains.custom });

  const override = opts.accessOverride ?? null;
  if (override) {
    if (override !== next.access) out.push({ kind: 'online_only', path: 'access', from: next.access, to: override });
  } else if (!before) {
    out.push({ kind: '+', path: 'access', to: next.access });
  } else if (before.access !== next.access) {
    out.push({ kind: '~', path: 'access', from: before.access, to: next.access });
  }

  if (!same(before?.public_paths ?? [], next.public_paths)) out.push({ kind: '~', path: 'public_paths', from: before?.public_paths ?? [], to: next.public_paths });
  diffMap('variables', before?.variables ?? {}, next.variables, out);
  diffMap('secrets', before?.secrets ?? {}, next.secrets, out);
  return out;
}

/** Compares migration files with what the app DB recorded. A changed sha256 is never allowed. */
export function classifyMigrations(
  files: MigrationFile[] | { file: string; sha256: string }[],
  applied: { file: string; sha256: string; deployment?: number | null }[],
): { pending: string[]; changed: string[]; applied: string[] } {
  const done = new Map(applied.map((a) => [a.file, a.sha256]));
  const pending: string[] = [];
  const changed: string[] = [];
  const ok: string[] = [];
  for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
    const sha = done.get(f.file);
    if (sha === undefined) pending.push(f.file);
    else if (sha !== f.sha256) changed.push(f.file);
    else ok.push(f.file);
  }
  return { pending, changed, applied: ok };
}

export interface OnlineCheckContext {
  appName: string;
  envName: string;
  secretExists: (ref: string) => boolean;
  uploadBytes?: number;
  /** Sign-in providers with OAuth credentials on this CP; the others are skipped at runtime. */
  configuredProviders?: string[];
}

/**
 * Checks only the CP can make (the CLI's `check` cannot know the platform's current limits or the
 * org's secrets). Errors use the same shape as `check --json`.
 */
export function onlineChecks(m: Manifest, ctx: OnlineCheckContext): { errors: CheckError[]; warnings: CheckWarning[] } {
  const errors: CheckError[] = [];
  const warnings: CheckWarning[] = [];
  const err = (rule: string, message: string) => errors.push({ file: 'boxlite.toml', rule, message });

  if (m.app !== ctx.appName) err('app_mismatch', `boxlite.toml names app "${m.app}" but the App key belongs to "${ctx.appName}"`);
  if (!IMAGE_REFS[m.runtime.image]) err('image_not_allowed', `[runtime].image "${m.runtime.image}" is not available; use one of ${Object.keys(IMAGE_REFS).join(', ')}`);
  if (!BOX_SIZES[m.runtime.size]) err('size_not_allowed', `[runtime].size "${m.runtime.size}" is not available; use one of ${Object.keys(BOX_SIZES).join(', ')}`);
  for (const p of m.auth?.providers ?? []) {
    if (!SUPPORTED_AUTH_PROVIDERS.includes(p)) err('invalid_auth', `[auth] provider "${p}" is unknown; use one of ${SUPPORTED_AUTH_PROVIDERS.join(', ')}`);
    else if (!(ctx.configuredProviders ?? []).includes(p)) warnings.push({ rule: 'auth_provider_not_configured', message: `${p}: not configured on this platform yet` });
  }
  for (const v of m.volumes) {
    // Sharing a volume from another env needs read-only mounts, which the platform rejects today.
    if (v.from) err('not_supported_yet', `[[volume]] "${v.name}": from = "${v.from}" is not supported yet`);
    else if (v.mode === 'ro') err('not_supported_yet', `[[volume]] "${v.name}": mode = "ro" is not supported yet (read-only mounts are rejected by the platform)`);
  }
  for (const [name, ref] of Object.entries(m.secrets)) {
    if (!ctx.secretExists(ref)) err('secret_not_found', ref.startsWith('app/') ? `[secrets] ${name} = "${ref}": no such App secret; store it with \`printf %s "$VALUE" | boxlite-app app secrets set ${ref.slice(4)}\`` : `[secrets] ${name} = "${ref}": no such org secret; an org admin must set it first, or store it as an App secret and reference app/<name>`);
  }
  if (ctx.uploadBytes !== undefined && ctx.uploadBytes > MAX_SNAPSHOT_BYTES) {
    err('upload_too_large', `upload is ${ctx.uploadBytes} bytes; the limit is ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return { errors, warnings };
}

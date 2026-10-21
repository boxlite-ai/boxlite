import type { Context } from 'hono';
import { parseManifest, type CheckError, type CheckWarning, type Manifest } from '@microcloud/shared';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import type { EnvRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';

export type C = Context<{ Variables: Vars }>;

export function envOf(ctx: Ctx, c: C): EnvRow {
  const name = c.req.param('env') ?? '';
  const env = ctx.store.envByName(c.get('app').id, name);
  if (!env) throw fail('not_found_env', `no environment "${name}" in app "${c.get('app').name}"`, '`boxlite-app app status` lists the environments');
  return env;
}

export async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw fail('invalid_request', 'request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw fail('invalid_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

export const migrationsSchema = z
  .array(z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sql: z.string() }))
  .max(1000)
  .optional();

/** Manifest object keys and the boxlite.toml key each one is written as. */
const MANIFEST_KEYS: Record<string, string> = {
  app: 'app',
  runtime: 'runtime',
  services: 'service',
  schedules: 'schedule',
  database: 'database',
  volumes: 'volume',
  auth: 'auth',
  domains: 'domains',
  access: 'access',
  variables: 'variables',
  secrets: 'secrets',
};

/** A JSON value as a TOML value. TOML has no null: null fields are left out, null array items become "". */
function tomlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(x ?? '')).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const fields = Object.entries(v).filter(([, x]) => x !== null && x !== undefined);
    return `{ ${fields.map(([k, x]) => `${JSON.stringify(k)} = ${tomlValue(x)}`).join(', ')} }`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return JSON.stringify(String(v));
  // JSON string escapes are valid TOML basic-string escapes; TOML also wants DEL escaped.
  return (JSON.stringify(v) ?? '""').replace(/\x7f/g, '\\u007f');
}

/**
 * A resolved Manifest object (what the CLI and the console send) as the boxlite.toml it stands
 * for, so it goes through exactly the shared parser and rules a TOML manifest does. Keys that
 * are not part of a Manifest are reported, not dropped.
 */
function manifestAsToml(obj: Record<string, unknown>): { toml: string; errors: CheckError[] } {
  const errors: CheckError[] = [];
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'environment') continue;
    const key = MANIFEST_KEYS[k];
    if (!key) {
      errors.push({ file: 'boxlite.toml', rule: 'unknown_field', message: `unknown field "${k}"` });
      continue;
    }
    if (v === null || v === undefined) continue;
    let value = v;
    if (k === 'app') value = { name: v };
    // `domains.builtin` is derived from the app name; only `custom` is written in boxlite.toml.
    if (k === 'domains' && typeof v === 'object' && !Array.isArray(v)) value = Object.fromEntries(Object.entries(v).filter(([dk]) => dk !== 'builtin'));
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  return { toml: lines.join('\n') + '\n', errors };
}

/**
 * `manifest` in plan/apply/deploy bodies is either the boxlite.toml text or an already-resolved
 * Manifest object for that env. Both go through the shared parser for this env, so a manifest
 * `boxlite-app check` rejects is rejected here too, whichever form it arrives in.
 */
export function readManifest(input: unknown, envName: string): { manifest: Manifest | null; errors: CheckError[]; warnings: CheckWarning[] } {
  if (typeof input === 'string') {
    const out = parseManifest(input, envName);
    return { manifest: out.errors.length ? null : (out.manifest ?? null), errors: out.errors, warnings: out.warnings };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { manifest: null, errors: [{ file: 'boxlite.toml', rule: 'invalid_manifest', message: 'manifest must be the boxlite.toml text or a Manifest object' }], warnings: [] };
  }
  const obj = input as Record<string, unknown>;
  if (obj.environment !== envName) {
    return { manifest: null, errors: [{ file: 'boxlite.toml', rule: 'env_mismatch', message: `manifest was resolved for env "${String(obj.environment)}", not "${envName}"` }], warnings: [] };
  }
  const { toml, errors: keyErrors } = manifestAsToml(obj);
  const out = parseManifest(toml, envName);
  // Line numbers would point into the generated text, not at a file the caller has.
  const errors = [...keyErrors, ...out.errors.map(({ line: _line, ...e }) => e)];
  return { manifest: errors.length ? null : (out.manifest ?? null), errors, warnings: out.warnings };
}

export function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw fail('invalid_request', `${name} must be a positive integer`);
  return n;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

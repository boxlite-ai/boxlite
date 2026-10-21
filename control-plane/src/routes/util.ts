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
  if (!env) throw fail('not_found_env', `no environment "${name}" in app "${c.get('app').name}"`, 'list them with `boxlite-app env list`');
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

/** The structural minimum of a Manifest object; detailed rules live in @microcloud/shared. */
const manifestObject = z
  .object({
    app: z.string(),
    environment: z.string(),
    runtime: z.object({ image: z.string(), size: z.string(), build: z.array(z.string()), output: z.string().nullable() }),
    services: z.array(z.object({ name: z.string() }).passthrough()),
    schedules: z.array(z.object({ name: z.string(), cron: z.string(), target: z.string() })),
    database: z.object({ migrations: z.string() }).nullable(),
    volumes: z.array(z.object({ name: z.string(), mount: z.string(), mode: z.string(), from: z.string().nullable(), path: z.string().nullable() })),
    auth: z.object({ providers: z.array(z.string()), protect: z.array(z.string()) }).nullable(),
    domains: z.object({ builtin: z.string(), custom: z.array(z.string()) }),
    access: z.enum(['private', 'org', 'public']),
    variables: z.record(z.string(), z.string()),
    secrets: z.record(z.string(), z.string()),
  })
  .passthrough();

/**
 * `manifest` in plan/apply/deploy bodies is either the boxlite.toml text (the CP parses it with
 * the shared parser for this env, so it re-runs every local rule) or an already-parsed Manifest
 * object for that env.
 */
export function readManifest(input: unknown, envName: string): { manifest: Manifest | null; errors: CheckError[]; warnings: CheckWarning[] } {
  if (typeof input === 'string') {
    const out = parseManifest(input, envName);
    return { manifest: out.errors.length ? null : (out.manifest ?? null), errors: out.errors, warnings: out.warnings };
  }
  const parsed = manifestObject.safeParse(input);
  if (!parsed.success) {
    return {
      manifest: null,
      errors: parsed.error.issues.map((i) => ({ file: 'boxlite.toml', rule: 'invalid_manifest', message: `${i.path.join('.')}: ${i.message}` })),
      warnings: [],
    };
  }
  const m = parsed.data as unknown as Manifest;
  if (m.environment !== envName) {
    return { manifest: null, errors: [{ file: 'boxlite.toml', rule: 'env_mismatch', message: `manifest was resolved for env "${m.environment}", not "${envName}"` }], warnings: [] };
  }
  return { manifest: m, errors: [], warnings: [] };
}

export function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw fail('invalid_request', `${name} must be a positive integer`);
  return n;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

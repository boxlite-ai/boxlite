import { Hono } from 'hono'
import { secretValue } from '../orgs'
import type { CheckError, CheckWarning, Manifest } from '@boxlite-ai/cloud-app-shared'
import { z } from 'zod'
import type { Vars } from '../auth'
import type { AppRow, Change, EnvRow, MigrationFile } from '../db'
import type { Ctx } from '../ctx'
import { appProviders } from '../enduser/config'
import { HttpError } from '../errors'
import { validateMigrationFiles } from '../migrations'
import { classifyMigrations, diffSpecs, onlineChecks } from '../spec'
import { body, envOf, migrationsSchema, readManifest } from './util'

export interface Prepared {
  manifest: Manifest | null
  errors: CheckError[]
  warnings: CheckWarning[]
  migrations: MigrationFile[]
  changes: Change[]
  latest: number
  stale: boolean
}

/** Shared by plan and apply/deploy: parse, re-check online, diff against the latest spec. */
export async function prepare(
  ctx: Ctx,
  app: AppRow,
  env: EnvRow,
  input: { manifest: unknown; base_version?: number; migrations?: MigrationFile[]; uploadBytes?: number },
): Promise<Prepared> {
  const { manifest, errors, warnings } = readManifest(input.manifest, env.name)
  const latest = await ctx.store.effectiveSpecVersion(env.id)
  const stale = (input.base_version ?? 0) < latest
  let migrations: MigrationFile[] = []
  try {
    migrations = validateMigrationFiles(input.migrations ?? [])
  } catch (err) {
    if (err instanceof HttpError && Array.isArray(err.details.errors))
      errors.push(...(err.details.errors as CheckError[]))
    else throw err
  }
  if (!manifest) return { manifest, errors, warnings, migrations, changes: [], latest, stale }

  const online = await onlineChecks(manifest, {
    runtimeImages: ctx.config.runtimeImages,
    appName: app.name,
    envName: env.name,
    secretExists: async (ref) => (await secretValue(ctx, app, ref)) !== undefined,
    uploadBytes: input.uploadBytes,
    configuredProviders: await appProviders(ctx, app),
    customDomains: false,
  })
  errors.push(...online.errors)
  warnings.push(...online.warnings)

  // Diff against what the env actually runs, not against a spec a failed deployment left behind.
  const prev = latest ? await ctx.store.spec(env.id, latest) : undefined
  const changes = diffSpecs(prev, manifest, { accessOverride: env.access_override, envName: env.name })
  if (manifest.database && migrations.length) {
    const { pending, changed } = classifyMigrations(migrations, prev?.database?.applied ?? [])
    for (const f of pending) changes.push({ kind: '+', path: `migrations/${f}`, to: 'pending' })
    const dir = manifest.database.migrations.replace(/\/?$/, '/')
    for (const f of changed)
      errors.push({
        file: `${dir}${f}`,
        rule: 'migration_changed',
        message: `${dir}${f} was already applied with different contents; add a new migration instead`,
      })
  }
  if (stale)
    warnings.push({
      rule: 'stale_base',
      message: `the environment is at spec v${latest} but you planned against v${input.base_version ?? 0}; \`boxlite-app app pull\` brings boxlite.toml up to date before you apply or deploy`,
    })
  return { manifest, errors, warnings, migrations, changes, latest, stale }
}

export function planRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>()
  r.post('/envs/:env/plan', async (c) => {
    const env = await envOf(ctx, c)
    const b = await body(
      c,
      z.object({
        manifest: z.unknown(),
        base_version: z.number().int().min(0).optional(),
        upload: z
          .object({
            files: z.number().optional(),
            bytes: z.number().optional(),
            warnings: z.array(z.unknown()).optional(),
          })
          .optional(),
        migrations: migrationsSchema,
      }),
    )
    const p = await prepare(ctx, c.get('app'), env, {
      manifest: b.manifest,
      base_version: b.base_version,
      migrations: b.migrations,
      uploadBytes: b.upload?.bytes,
    })
    for (const w of b.upload?.warnings ?? []) {
      if (typeof w === 'string') p.warnings.push({ rule: 'upload', message: w })
      else if (w && typeof w === 'object' && 'message' in w)
        p.warnings.push({
          rule: String((w as { rule?: unknown }).rule ?? 'upload'),
          message: String((w as { message: unknown }).message),
        })
    }
    return c.json({
      latest_version: p.latest,
      stale: p.stale,
      changes: p.changes,
      errors: p.errors,
      warnings: p.warnings,
    })
  })
  return r
}

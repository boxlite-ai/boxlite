// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Migration as JournalEntry, MigrationInterface, QueryRunner } from 'typeorm'
import { z } from 'zod'
import { baseDataSourceOptions } from './data-source'
import { MigrationDataSource } from './migration-data-source'
import { runBundledReleaseAdmission } from './bundled-release-admission'

type Phase = 'all' | 'pre-deploy' | 'post-deploy'
type MigrationPhase = 'baseline' | Exclude<Phase, 'all'>
type Migration = new () => MigrationInterface
type MigrationManifest = Record<MigrationPhase, string[]>

const identities = z.array(z.string().regex(/^\w+\d{13}$/))
const expectedMigrations = z.strictObject({ baseline: identities, 'pre-deploy': identities, 'post-deploy': identities })
const databaseIdentifier = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0') && Buffer.byteLength(value) <= 63)
const expectedDatabase = z.strictObject({ database: databaseIdentifier, username: databaseIdentifier })

async function checkMigrationDatabase(input: string | undefined) {
  let expected: z.infer<typeof expectedDatabase>
  try {
    if (!input || Buffer.byteLength(input) > 2048) throw new Error()
    expected = expectedDatabase.parse(JSON.parse(input))
  } catch {
    throw new Error('Provide the expected database and owner login in BOXLITE_EXPECTED_DATABASE')
  }
  const source = new MigrationDataSource({
    ...baseDataSourceOptions,
    entities: [],
    migrations: [],
    logging: false,
    extra: { connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on -c statement_timeout=5000' },
  })
  await source.initialize()
  try {
    const [connected] = await source.query(
      'SELECT current_database() AS database, session_user AS username, NOT pg_is_in_recovery() AS primary_server',
    )
    if (
      connected?.database !== expected.database ||
      connected?.username !== expected.username ||
      !connected.primary_server
    ) {
      throw new Error('Migration Job must connect to the declared database primary with its owner login')
    }
    console.log('Migration database connection verified')
  } finally {
    await source.destroy()
  }
}

function readMigrations(entries: string[]) {
  // Load the actual emitted modules, outside Webpack's compile-time require context.
  const load = createRequire(join(__dirname, 'migrate.js'))
  return entries.map((entry) => {
    const exported = Object.values(load(`./${entry}`))
    const migrations = exported.filter(
      (value): value is Migration =>
        typeof value === 'function' &&
        typeof value.prototype?.up === 'function' &&
        typeof value.prototype?.down === 'function',
    )
    if (migrations.length !== 1) throw new Error(`Expected one migration class in ${entry}`)
    return migrations[0]
  })
}

function verifyBundleIdentities(manifest: MigrationManifest, input: string | undefined) {
  if (!input || Buffer.byteLength(input) > 1024 * 1024) {
    throw new Error('Provide BOXLITE_EXPECTED_MIGRATIONS from the reviewed release commit')
  }
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    throw new Error('Invalid expected migration identities')
  }
  const expected = expectedMigrations.parse(payload)
  const names = Object.values(expected).flat()
  if (new Set(names).size !== names.length) throw new Error('Duplicate expected migration identities')
  for (const phase of ['baseline', 'pre-deploy', 'post-deploy'] as const) {
    const shipped = readMigrations(manifest[phase])
      .map((migration) => migration.name)
      .sort()
    if (JSON.stringify(shipped) !== JSON.stringify(expected[phase].sort())) {
      throw new Error(`Migration bundle does not match the expected ${phase} identities`)
    }
  }
  return new Set(names)
}

function verifyJournal(journal: JournalEntry[], reviewed: Set<string>) {
  const recorded = new Set<string>()
  for (const { name, timestamp } of journal) {
    if (!reviewed.has(name)) throw new Error(`Unexpected database migration ${name}`)
    if (recorded.has(name) || Number(timestamp) !== Number(name.slice(-13))) {
      throw new Error(`Invalid or duplicate database migration record for ${name}`)
    }
    recorded.add(name)
  }
  return recorded
}

async function verifyFirstProvisioning(runner: QueryRunner, recorded: Set<string>, migrations: Migration[]) {
  const ordered = migrations.map((migration) => migration.name).sort((a, b) => a.slice(-13).localeCompare(b.slice(-13)))
  if (recorded.size > ordered.length || ordered.slice(0, recorded.size).some((name) => !recorded.has(name))) {
    throw new Error('Initial release journal must be a prefix of the baseline and pre-deploy migrations')
  }
  if (recorded.size === 0) {
    const [catalog] = await runner.query(`SELECT EXISTS (
      SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND c.relname <> 'migrations'
        AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid AND d.deptype = 'e')
    ) AS populated`)
    if (catalog.populated) throw new Error('Initial release with no journal requires an empty application schema')
  }
  const [catalog] = await runner.query("SELECT to_regclass('complete_outbound_admission') IS NOT NULL AS present")
  if (!catalog.present) return
  const [control] = await runner.query(
    'SELECT phase, minimum_release, api_principal, deployment_receipt FROM complete_outbound_admission WHERE id = 1',
  )
  if (
    control?.phase !== 'closed' ||
    control.minimum_release !== null ||
    control.api_principal !== null ||
    control.deployment_receipt !== null
  ) {
    throw new Error('Initial provisioning cannot reuse an active or previously admitted database')
  }
}

async function verifyReleaseExpansion(runner: QueryRunner, recorded: Set<string>, baseline: Migration[]) {
  if (baseline.some((migration) => !recorded.has(migration.name))) {
    throw new Error('Pending database migrations for pre-deploy')
  }
  const [table] = await runner.query("SELECT to_regclass('complete_outbound_admission') IS NOT NULL AS present")
  if (!table.present) return
  const [admission] = await runner.query('SELECT phase FROM complete_outbound_admission WHERE id = 1')
  if (admission?.phase !== 'closed') {
    throw new Error('Complete outbound admission must be closed before release expansion')
  }
}

export async function runBundledMigrationCommand([command, phase = 'all', ...options]: string[]) {
  if (command === 'check-database') {
    if (phase !== 'all' || options.length) throw new Error('check-database uses only BOXLITE_EXPECTED_DATABASE')
    await checkMigrationDatabase(process.env.BOXLITE_EXPECTED_DATABASE)
    return
  }
  if (command === 'release') {
    if (phase !== 'all' || options.length) throw new Error('Release admission uses only BOXLITE_RELEASE_REQUEST')
    console.log(JSON.stringify(await runBundledReleaseAdmission(process.env.BOXLITE_RELEASE_REQUEST)))
    return
  }
  if (phase !== 'all' && phase !== 'pre-deploy' && phase !== 'post-deploy') {
    throw new Error(`Unknown migration phase ${phase}`)
  }
  const checkBundle = command === 'check-bundle' && phase === 'all' && options.length === 0
  const firstProvisioning =
    command === 'run' &&
    phase === 'pre-deploy' &&
    options.length === 2 &&
    options[0] === '--include-baseline' &&
    options[1] === '--require-first-provisioning'
  const bootstrap =
    firstProvisioning ||
    (command === 'run' && phase === 'pre-deploy' && options.length === 1 && options[0] === '--include-baseline')
  const releaseExpansion =
    command === 'run' && phase === 'pre-deploy' && options.length === 1 && options[0] === '--require-admission-closed'
  if (command === 'run' && phase === 'post-deploy') {
    if (options.length !== 1 || options[0] !== '--old-replicas-retired') {
      throw new Error('Post-deploy requires --old-replicas-retired after verifying the old API replicas are stopped')
    }
  } else if (command === 'revert' && phase === 'all') {
    if (options.length && (options.length !== 2 || options[0] !== '--transaction' || options[1] !== 'none')) {
      throw new Error('Revert accepts --transaction none for a concurrent index migration')
    }
  } else if (
    !bootstrap &&
    !releaseExpansion &&
    !checkBundle &&
    ((command !== 'run' && command !== 'list' && command !== 'verify') || options.length)
  ) {
    throw new Error(
      'Usage: migrate.js check-bundle, check-database, <list|run|verify> [all|pre-deploy|post-deploy], or revert all [--transaction none]',
    )
  }

  const verify = command === 'verify'
  const manifest = JSON.parse(readFileSync(join(__dirname, 'migration-phases.json'), 'utf8')) as MigrationManifest
  const expected = process.env.BOXLITE_EXPECTED_MIGRATIONS
  const reviewed =
    checkBundle || verify || releaseExpansion || firstProvisioning || (command === 'run' && expected !== undefined)
      ? verifyBundleIdentities(manifest, expected)
      : undefined
  if (checkBundle) {
    console.log('Migration bundle verified')
    return
  }
  const includeBaseline = bootstrap || (verify && phase === 'pre-deploy')
  const entries =
    phase === 'all'
      ? Object.values(manifest).flat()
      : [...(includeBaseline ? manifest.baseline : []), ...manifest[phase]]
  const migrations = readMigrations(entries)
  if (command === 'list') {
    console.log(JSON.stringify(migrations.map((migration) => migration.name).sort()))
    return
  }

  const source = new MigrationDataSource({
    ...baseDataSourceOptions,
    entities: [],
    migrations,
    logging: !verify,
    ...(verify ? { extra: { options: '-c default_transaction_read_only=on' } } : {}),
  })
  await source.initialize()
  try {
    if (verify && reviewed) {
      const recorded = verifyJournal(await source.readMigrationJournal(), reviewed)
      if (migrations.some((migration) => !recorded.has(migration.name))) {
        throw new Error(`Pending database migrations for ${phase}`)
      }
      console.log(JSON.stringify({ phase, verified: migrations.length }))
    } else if ((releaseExpansion || firstProvisioning) && reviewed) {
      await source.runMigrations({
        guard: async (runner, journal) => {
          const recorded = verifyJournal(journal, reviewed)
          if (firstProvisioning) await verifyFirstProvisioning(runner, recorded, migrations)
          else await verifyReleaseExpansion(runner, recorded, readMigrations(manifest.baseline))
        },
      })
    } else if (command === 'run') await source.runMigrations()
    else if (command === 'revert')
      await source.undoLastMigration({ transaction: options[1] === 'none' ? 'none' : 'all' })
  } finally {
    await source.destroy()
  }
}

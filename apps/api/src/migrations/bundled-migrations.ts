// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { MigrationInterface } from 'typeorm'
import { baseDataSourceOptions } from './data-source'
import { MigrationDataSource } from './migration-data-source'

type Phase = 'all' | 'pre-deploy' | 'post-deploy'
type Migration = new () => MigrationInterface

function bundledMigrations(phase: Phase) {
  const manifest = JSON.parse(readFileSync(join(__dirname, 'migration-phases.json'), 'utf8')) as Record<
    'baseline' | Exclude<Phase, 'all'>,
    string[]
  >
  const entries = phase === 'all' ? Object.values(manifest).flat() : manifest[phase]
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

export async function runBundledMigrationCommand([command, phase = 'all', ...options]: string[]) {
  if (phase !== 'all' && phase !== 'pre-deploy' && phase !== 'post-deploy') {
    throw new Error(`Unknown migration phase ${phase}`)
  }
  if (command === 'run' && phase === 'post-deploy') {
    if (options.length !== 1 || options[0] !== '--old-replicas-retired') {
      throw new Error('Post-deploy requires --old-replicas-retired after verifying the old API replicas are stopped')
    }
  } else if (command === 'revert' && phase === 'all') {
    if (options.length && (options.length !== 2 || options[0] !== '--transaction' || options[1] !== 'none')) {
      throw new Error('Revert accepts --transaction none for a concurrent index migration')
    }
  } else if ((command !== 'run' && command !== 'list') || options.length) {
    throw new Error(
      'Usage: migrate.js <list|run> [all|pre-deploy|post-deploy] or migrate.js revert all [--transaction none]',
    )
  }

  const migrations = bundledMigrations(phase)
  if (command === 'list') {
    console.log(JSON.stringify(migrations.map((migration) => migration.name).sort()))
    return
  }

  const source = new MigrationDataSource({ ...baseDataSourceOptions, entities: [], migrations, logging: true })
  await source.initialize()
  try {
    if (command === 'run') await source.runMigrations()
    else await source.undoLastMigration({ transaction: options[1] === 'none' ? 'none' : 'all' })
  } finally {
    await source.destroy()
  }
}

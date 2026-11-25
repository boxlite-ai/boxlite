/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const { composePlugins, withNx } = require('@nx/webpack')
const path = require('path')
const glob = require('glob')

const migrationRoot = path.join(__dirname, 'src/migrations')
const migrationEntries = {}
const migrationPhases = { baseline: [], 'pre-deploy': [], 'post-deploy': [] }
for (const file of glob.sync('**/*-migration.{ts,js}', { cwd: migrationRoot }).sort()) {
  const directory = path.dirname(file)
  const phase = directory === '.' ? 'baseline' : directory
  const entry = `migrations/${path.basename(file, path.extname(file))}`
  if (!Object.hasOwn(migrationPhases, phase) || Object.hasOwn(migrationEntries, entry)) {
    throw new Error(`Invalid migration entry: ${file}`)
  }
  migrationEntries[entry] = path.join(migrationRoot, file)
  migrationPhases[phase].push(`${entry}.js`)
}

module.exports = composePlugins(
  // Default Nx composable plugin
  withNx(),
  // Custom composable plugin
  (config, { options, context }) => {
    // `config` is the Webpack configuration object
    // `options` is the options passed to the `@nx/webpack:webpack` executor
    // `context` is the context passed to the `@nx/webpack:webpack` executor
    // customize configuration here
    config.output.devtoolModuleFilenameTemplate = function (info) {
      const rel = path.relative(process.cwd(), info.absoluteResourcePath)
      return `webpack:///./${rel}`
    }
    // Preserve openapi files while cleaning other build artifacts
    config.output.clean = {
      keep: /openapi.*\.json$/,
    }
    Object.assign(config.entry, migrationEntries, { migrate: path.join(__dirname, 'src/migrate.ts') })
    config.plugins.push({
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('MigrationPhases', (compilation) => {
          const { Compilation, sources } = compiler.webpack
          compilation.hooks.processAssets.tap(
            { name: 'MigrationPhases', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
            () => compilation.emitAsset('migration-phases.json', new sources.RawSource(JSON.stringify(migrationPhases))),
          )
        })
      },
    })
    config.mode = process.env.NODE_ENV

    config.watchOptions = {
      ignored: /node_modules/,
    }
    return config
  },
)

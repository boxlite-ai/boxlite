/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const { composePlugins, withNx } = require('@nx/webpack')
const path = require('path')
const glob = require('glob')

const migrationFiles = glob.sync('apps/api/src/migrations/**/*-migration.{ts,js}')
const migrationEntries = migrationFiles.reduce((acc, migrationFile) => {
  const entryName = migrationFile.substring(migrationFile.lastIndexOf('/') + 1, migrationFile.lastIndexOf('.'))
  acc[entryName] = migrationFile
  return acc
}, {})

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
    // add typeorm migrations as entry points
    for (const key in migrationEntries) {
      config.entry[`migrations/${key}`] = migrationEntries[key]
    }
    config.mode = process.env.NODE_ENV

    // Local dev only (NODE_ENV=development, set by infra-local's stack-up via
    // apps/.env). `nx serve api` triggers the base `api:build` target, which
    // would otherwise (a) crash inside @nx/webpack's GeneratePackageJsonPlugin
    // in this workspace and (b) fail type-checking on the pre-existing
    // @opentelemetry/otlp-exporter-base version skew in the lockfile (a
    // type-only mismatch in tracing.ts — the OTLP exporters work at runtime).
    // Drop both plugins so the API builds and serves locally. Production
    // (NODE_ENV=production) keeps both: the pruned deploy package.json and
    // full type-checking.
    if (process.env.NODE_ENV === 'development') {
      const devSkipPlugins = new Set(['GeneratePackageJsonPlugin', 'ForkTsCheckerWebpackPlugin'])
      config.plugins = (config.plugins || []).filter(
        (plugin) => !devSkipPlugins.has(plugin?.constructor?.name),
      )
    }

    config.watchOptions = {
      ignored: /node_modules/,
    }
    return config
  },
)

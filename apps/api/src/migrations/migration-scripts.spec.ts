/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('migration workspace scripts', () => {
  const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  it('resolves migration paths from the apps workspace', () => {
    for (const name of [
      'migration:generate',
      'migration:run:init',
      'migration:run:pre-deploy',
      'migration:run:post-deploy',
      'migration:revert',
    ]) {
      expect(packageJson.scripts[name]).toContain('cd api')
      expect(packageJson.scripts[name]).toContain('../node_modules/typeorm/cli.js')
      expect(packageJson.scripts[name]).not.toContain('cd apps/api')
    }
  })

  it('targets the dedicated post-deploy data source', () => {
    expect(packageJson.scripts['migration:run:post-deploy']).toContain('-d ./src/migrations/post-deploy/data-source.ts')
  })
})

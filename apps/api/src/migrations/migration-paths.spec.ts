/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { apiStartupMigrationPaths } from './migration-paths'

describe('API startup migration routing', () => {
  it('loads baseline and pre-deploy migrations but never post-deploy validation', () => {
    const paths = apiStartupMigrationPaths('/application')

    expect(paths).toEqual([
      '/application/migrations/*-migration.{ts,js}',
      '/application/migrations/pre-deploy/*-migration.{ts,js}',
    ])
    expect(paths.some((path) => path.includes('post-deploy'))).toBe(false)
  })
})

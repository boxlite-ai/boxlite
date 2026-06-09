/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getMetadataArgsStorage } from 'typeorm'
import { WarmPool } from './warm-pool.entity'

describe('WarmPool entity column mapping', () => {
  it('binds the template property to the saved-image-renamed "savedImage" DB column', () => {
    // The shared dev DB renamed warm_pool.template -> warm_pool.savedImage (saved-image
    // migration, no template-compat copy). The entity must select/write "savedImage" or
    // create/start write paths throw `column "WarmPool.template" does not exist`.
    const templateColumn = getMetadataArgsStorage()
      .columns.filter((column) => column.target === WarmPool)
      .find((column) => column.propertyName === 'template')

    expect(templateColumn).toBeDefined()
    expect(templateColumn?.options.name).toBe('savedImage')
  })
})

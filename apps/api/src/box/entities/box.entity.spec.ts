/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_ID_LENGTH, BOX_ID_REGEX } from '../utils/box-id.util'
import { Box } from './box.entity'

describe('Box entity identity', () => {
  it('mints a single 12-character base62 id (no separate internal UUID)', () => {
    const box = new Box('us', 'data-loader')

    expect(box.id).toHaveLength(BOX_ID_LENGTH)
    expect(box.id).toMatch(BOX_ID_REGEX)
    expect(box.name).toBe('data-loader')
  })

  it('mints unique ids per box', () => {
    expect(new Box('us').id).not.toBe(new Box('us').id)
  })
})

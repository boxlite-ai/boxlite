/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_ID_LENGTH, BOX_ID_REGEX } from '../utils/box-id.util'
import { Box } from './box.entity'

describe('Box entity public identity', () => {
  it('mints a 12-character public boxId separately from the internal UUID', () => {
    const box = new Box('us', 'data-loader')

    expect(box.id).toBeDefined()
    expect(box.boxId).toHaveLength(BOX_ID_LENGTH)
    expect(box.boxId).toMatch(BOX_ID_REGEX)
    expect(box.boxId).not.toBe(box.id)
    expect(box.name).toBe('data-loader')
  })
})

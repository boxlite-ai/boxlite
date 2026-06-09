/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOX_ID_LENGTH, BOX_ID_REGEX } from '../utils/box-id.util'
import { Sandbox } from './sandbox.entity'

describe('Sandbox entity public identity', () => {
  it('mints a 12-character public boxId separately from the internal UUID', () => {
    const sandbox = new Sandbox('us', 'data-loader')

    expect(sandbox.id).toBeDefined()
    expect(sandbox.boxId).toHaveLength(BOX_ID_LENGTH)
    expect(sandbox.boxId).toMatch(BOX_ID_REGEX)
    expect(sandbox.boxId).not.toBe(sandbox.id)
    expect(sandbox.name).toBe('data-loader')
  })
})

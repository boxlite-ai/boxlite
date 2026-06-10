/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxDto } from './box.dto'

jest.mock('uuid', () => ({
  v4: () => '057963b2-60ca-4356-81fc-11503e15f249',
}))

describe('BoxDto lifecycle policy exposure', () => {
  it('does not expose the unsupported auto-archive lifecycle policy', () => {
    const box = new Box('us', 'data-loader')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'boxlite'

    const dto = BoxDto.fromBox(box, 'https://proxy.boxlite.dev/toolbox')

    expect(dto).not.toHaveProperty('autoArchiveInterval')
  })
})

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxDto } from './box.dto'

describe('BoxDto public identity', () => {
  it('exposes a single public id without a legacy boxId alias', () => {
    const box = new Box('us', 'data-loader')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'boxlite'

    const dto = BoxDto.fromBox(box, 'https://proxy.boxlite.dev/toolbox')

    expect(dto.id).toBe(box.id)
    expect((dto as any).boxId).toBeUndefined()
    expect(dto.privileged).toBe(false)
    expect(dto.capabilities).toEqual({ add: [], drop: [] })
  })

  it('reads back a stored privileged box', () => {
    const box = new Box('us', 'dind')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'boxlite'
    // The shape box.service.ts persists for a privileged create.
    box.privileged = true
    box.capabilities = { add: ['ALL'], drop: [] }

    const dto = BoxDto.fromBox(box, 'https://proxy.boxlite.dev/toolbox')

    expect(dto.privileged).toBe(true)
    expect(dto.capabilities).toEqual({ add: ['ALL'], drop: [] })
  })
})

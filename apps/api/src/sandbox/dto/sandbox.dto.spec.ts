/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { SandboxDto } from './sandbox.dto'

describe('SandboxDto public identity', () => {
  it('exposes the public boxId separately from the internal UUID', () => {
    const sandbox = new Sandbox('us', 'data-loader')
    sandbox.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    sandbox.osUser = 'boxlite'

    const dto = SandboxDto.fromSandbox(sandbox, 'https://proxy.boxlite.dev/toolbox')

    expect(dto.id).toBe(sandbox.id)
    expect(dto.boxId).toBe(sandbox.boxId)
    expect(dto.boxId).not.toBe(sandbox.id)
  })
})

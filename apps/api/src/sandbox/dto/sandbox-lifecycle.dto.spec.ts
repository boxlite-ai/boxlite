/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { SandboxDto } from './sandbox.dto'

jest.mock('uuid', () => ({
  v4: () => '057963b2-60ca-4356-81fc-11503e15f249',
}))

describe('SandboxDto lifecycle policy exposure', () => {
  it('does not expose the unsupported auto-archive lifecycle policy', () => {
    const sandbox = new Sandbox('us', 'data-loader')
    sandbox.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    sandbox.osUser = 'boxlite'

    const dto = SandboxDto.fromSandbox(sandbox, 'https://proxy.boxlite.dev/toolbox')

    expect(dto).not.toHaveProperty('autoArchiveInterval')
  })
})

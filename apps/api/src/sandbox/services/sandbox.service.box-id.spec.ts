/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }))

import { Not } from 'typeorm'
import { Sandbox } from '../entities/sandbox.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxService } from './sandbox.service'

function createService(findOne: jest.Mock): SandboxService {
  const service = Object.create(SandboxService.prototype) as SandboxService
  ;(service as any).sandboxRepository = { findOne }
  return service
}

describe('SandboxService public identity lookup', () => {
  it('resolves the public boxId before falling back to the internal UUID or name', async () => {
    const organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    const sandbox = new Sandbox('us', 'data-loader')
    sandbox.organizationId = organizationId

    const findOne = jest.fn().mockResolvedValueOnce(sandbox)
    const service = createService(findOne)

    await expect(service.findOneByIdOrName(sandbox.boxId, organizationId)).resolves.toBe(sandbox)

    expect(findOne).toHaveBeenCalledTimes(1)
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          boxId: sandbox.boxId,
          organizationId,
          state: Not(SandboxState.DESTROYED),
        },
      }),
    )
  })
})

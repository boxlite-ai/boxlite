/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { BoxAccessGuard } from './box-access.guard'

function requestContext(runnerId: string, boxId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { role: 'runner', runnerId },
        params: { boxId },
      }),
    }),
  } as ExecutionContext
}

describe('BoxAccessGuard exact Box identity', () => {
  const boxService = {
    getRunnerId: jest.fn(),
    getRunnerIdById: jest.fn(),
  }
  const guard = new BoxAccessGuard(boxService as never)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('cannot authorize an exact-ID state callback through a same-name Box owned by the caller', async () => {
    boxService.getRunnerId.mockResolvedValue('attacker-runner')
    boxService.getRunnerIdById.mockResolvedValue('victim-runner')

    await expect(guard.canActivate(requestContext('attacker-runner', 'box000000001'))).rejects.toThrow(
      NotFoundException,
    )

    expect(boxService.getRunnerIdById).toHaveBeenCalledWith('box000000001')
    expect(boxService.getRunnerId).not.toHaveBeenCalled()
  })

  it('allows the runner that owns the exact Box ID', async () => {
    boxService.getRunnerIdById.mockResolvedValue('victim-runner')

    await expect(guard.canActivate(requestContext('victim-runner', 'box000000001'))).resolves.toBe(true)

    expect(boxService.getRunnerIdById).toHaveBeenCalledWith('box000000001')
  })
})

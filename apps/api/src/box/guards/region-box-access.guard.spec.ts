/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { RegionBoxAccessGuard } from './region-box-access.guard'

function requestContext(user: object, boxId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params: { boxId } }),
    }),
  } as ExecutionContext
}

describe('RegionBoxAccessGuard exact Box identity', () => {
  const boxService = {
    getRegionId: jest.fn(),
    getRegionIdById: jest.fn(),
  }
  const guard = new RegionBoxAccessGuard(boxService as never)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('cannot authorize an exact-ID route through a same-name Box in the caller region', async () => {
    boxService.getRegionId.mockResolvedValue('attacker-region')
    boxService.getRegionIdById.mockResolvedValue('victim-region')
    const context = requestContext({ role: 'region-proxy', regionId: 'attacker-region' }, 'box000000001')

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException)

    expect(boxService.getRegionIdById).toHaveBeenCalledWith('box000000001')
    expect(boxService.getRegionId).not.toHaveBeenCalled()
  })

  it('allows the exact Box when its region matches the region gateway', async () => {
    boxService.getRegionIdById.mockResolvedValue('victim-region')
    const context = requestContext({ role: 'region-ssh-gateway', regionId: 'victim-region' }, 'box000000001')

    await expect(guard.canActivate(context)).resolves.toBe(true)

    expect(boxService.getRegionIdById).toHaveBeenCalledWith('box000000001')
  })
})

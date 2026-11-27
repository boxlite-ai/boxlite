/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxAccessGuard } from './box-access.guard'

describe('BoxAccessGuard runner snapshot', () => {
  it('reuses the Box read for runner ownership and state reporting', async () => {
    const box = { id: 'box-1', runnerId: 'runner-1' }
    const boxService = {
      findOneByIdOrName: jest.fn().mockResolvedValue(box),
      getRunnerId: jest.fn().mockResolvedValue('runner-1'),
    }
    const guard = new BoxAccessGuard(boxService as any)
    const request = { params: { boxId: 'box-1' }, user: { role: 'runner', runnerId: 'runner-1' } }
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as any

    await expect(guard.canActivate(context)).resolves.toBe(true)

    const [snapshotKey] = Object.getOwnPropertySymbols(request)
    expect(request[snapshotKey]).toBe(box)
    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('box-1', undefined, true, undefined, false)
    expect(boxService.getRunnerId).not.toHaveBeenCalled()
  })
})

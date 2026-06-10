/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }))

import { Not } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxService } from './box.service'

function createService(findOne: jest.Mock): BoxService {
  const service = Object.create(BoxService.prototype) as BoxService
  ;(service as any).boxRepository = { findOne }
  return service
}

describe('BoxService public identity lookup', () => {
  it('resolves the public boxId before falling back to the internal UUID or name', async () => {
    const organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    const box = new Box('us', 'data-loader')
    box.organizationId = organizationId

    const findOne = jest.fn().mockResolvedValueOnce(box)
    const service = createService(findOne)

    await expect(service.findOneByIdOrName(box.boxId, organizationId)).resolves.toBe(box)

    expect(findOne).toHaveBeenCalledTimes(1)
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          boxId: box.boxId,
          organizationId,
          state: Not(BoxState.DESTROYED),
        },
      }),
    )
  })
})

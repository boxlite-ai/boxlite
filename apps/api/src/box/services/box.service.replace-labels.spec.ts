/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxService } from './box.service'
import { BOX_IMAGE_REF_LABEL } from '../constants/curated-images.constant'

function createService(box: Box, update: jest.Mock): BoxService {
  const service = Object.create(BoxService.prototype) as BoxService
  ;(service as any).findOneByIdOrName = jest.fn().mockResolvedValue(box)
  ;(service as any).boxRepository = { update }
  return service
}

describe('BoxService.replaceLabels reserved-label guard', () => {
  const imageRef = 'ghcr.io/boxlite-ai/boxlite-agent-base@sha256:deadbeef'

  function boxWithImageRef(): Box {
    const box = new Box('us', 'guarded-box')
    box.id = '11111111-1111-4111-8111-111111111111'
    box.labels = { [BOX_IMAGE_REF_LABEL]: imageRef, existing: 'keep' }
    return box
  }

  it('drops a user-supplied reserved image-ref label and preserves the resolved one', async () => {
    const box = boxWithImageRef()
    const update = jest.fn().mockImplementation((_id, { updateData }) => ({ ...box, ...updateData }))
    const service = createService(box, update)

    await service.replaceLabels(box.id, {
      [BOX_IMAGE_REF_LABEL]: 'ghcr.io/attacker/evil@sha256:0000',
      mine: 'value',
    })

    const persistedLabels = update.mock.calls[0][1].updateData.labels
    // The attacker's reserved key must not survive; the runner-pulled ref stays pinned to the
    // server-resolved curated image.
    expect(persistedLabels[BOX_IMAGE_REF_LABEL]).toBe(imageRef)
    expect(persistedLabels.mine).toBe('value')
  })

  it('does not reintroduce the reserved label when the box never had one', async () => {
    const box = new Box('us', 'plain-box')
    box.id = '22222222-2222-4222-8222-222222222222'
    box.labels = { foo: 'bar' }
    const update = jest.fn().mockImplementation((_id, { updateData }) => ({ ...box, ...updateData }))
    const service = createService(box, update)

    await service.replaceLabels(box.id, { foo: 'baz' })

    const persistedLabels = update.mock.calls[0][1].updateData.labels
    expect(persistedLabels).not.toHaveProperty(BOX_IMAGE_REF_LABEL)
    expect(persistedLabels.foo).toBe('baz')
  })
})

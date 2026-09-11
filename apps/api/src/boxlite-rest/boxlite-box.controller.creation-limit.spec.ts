/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'

const organization = { id: '11111111-1111-4111-8111-111111111111' }
const authContext = { organization, organizationId: organization.id }
const startedBox = {
  id: 'box-1',
  organizationId: organization.id,
  name: 'box-1',
  state: BoxState.STARTED,
  image: 'boxlite/base',
  cpu: 1,
  memory: 1,
  labels: {},
}

function makeController() {
  const boxService = {
    create: jest.fn().mockResolvedValue(startedBox),
    findOneByIdOrName: jest.fn().mockResolvedValue(startedBox),
    start: jest.fn().mockResolvedValue(startedBox),
    stop: jest.fn().mockResolvedValue({ id: 'box-1' }),
    toBoxDto: jest.fn().mockResolvedValue(startedBox),
  }
  const boxStateWaiter = { waitForStarted: jest.fn() }
  const commerceBoxLimitService = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
  const controller = new BoxliteBoxController(
    boxService as never,
    boxStateWaiter as never,
    commerceBoxLimitService as never,
  )
  return { controller, boxService, boxStateWaiter, commerceBoxLimitService }
}

describe('BoxliteBoxController creation limit', () => {
  it('resolves the organization limit and passes it only to create', async () => {
    const { controller, boxService, boxStateWaiter, commerceBoxLimitService } = makeController()

    const response = await controller.createBox(authContext as never, { image: 'boxlite/base' } as never)

    expect(commerceBoxLimitService.resolveMaxCreatedBoxes).toHaveBeenCalledWith(organization.id)
    expect(boxService.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'boxlite/base' }),
      organization,
      { maxCreatedBoxes: 3 },
    )
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
    expect(response).toEqual(expect.objectContaining({ box_id: 'box-1', status: 'running' }))

    await controller.startBox(authContext as never, 'box-1')
    await controller.stopBox(authContext as never, 'box-1')
    expect(commerceBoxLimitService.resolveMaxCreatedBoxes).toHaveBeenCalledTimes(1)
  })

  it('does not persist or wait for startup when Commerce admission fails', async () => {
    const { controller, boxService, boxStateWaiter, commerceBoxLimitService } = makeController()
    commerceBoxLimitService.resolveMaxCreatedBoxes.mockRejectedValue(new Error('commerce unavailable'))

    await expect(controller.createBox(authContext as never, {} as never)).rejects.toThrow('commerce unavailable')
    expect(boxService.create).not.toHaveBeenCalled()
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
  })

  it('does not wait for startup when the repository rejects at the limit', async () => {
    const { controller, boxService, boxStateWaiter } = makeController()
    boxService.create.mockRejectedValue(new BoxCreationLimitExceededError(3, 3))

    await expect(controller.createBox(authContext as never, {} as never)).rejects.toBeInstanceOf(
      BoxCreationLimitExceededError,
    )
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { Context } from '../common/context/context'

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
    destroy: jest.fn().mockResolvedValue(startedBox),
    findOneByIdOrName: jest.fn().mockResolvedValue({ ...startedBox, state: BoxState.STOPPED }),
    start: jest.fn().mockResolvedValue(startedBox),
    stop: jest.fn().mockResolvedValue(startedBox),
    toBoxDto: jest.fn().mockResolvedValue(startedBox),
  }
  const commerceBoxLimitService = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
  const controller = new BoxliteBoxController(boxService as never, {} as never, commerceBoxLimitService as never)
  return { controller, boxService }
}

describe('BoxliteBoxController business event actor', () => {
  // UserContext builds this from the request: who called, and how.
  const ctx = Context.user({ userId: 'user-1', authMethod: 'api_key' })

  it('creates, starts, stops and deletes a box as the calling user', async () => {
    const { controller, boxService } = makeController()

    await controller.createBox(authContext as never, { image: 'boxlite/base' } as never, ctx)
    await controller.startBox(authContext as never, 'box-1', ctx)
    await controller.stopBox(authContext as never, 'box-1', ctx)
    await controller.removeBox(authContext as never, 'box-1', ctx)

    expect(boxService.create).toHaveBeenCalledWith(expect.anything(), organization, ctx, expect.anything())
    expect(boxService.start).toHaveBeenCalledWith('box-1', organization, ctx)
    expect(boxService.stop).toHaveBeenCalledWith('box-1', organization.id, ctx)
    expect(boxService.destroy).toHaveBeenCalledWith('box-1', organization.id, ctx)
  })
})

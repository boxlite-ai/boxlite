/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { Context } from '../common/context/context'
import { subscribeBusinessEvents } from '../common/utils/business-event.util'

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
  const controller = new BoxliteBoxController(
    boxService as never,
    {} as never,
    commerceBoxLimitService as never,
    {} as never,
  )
  return { controller, boxService }
}

describe('BoxliteBoxController business event actor', () => {
  // UserContext builds this from the request: who called, and how.
  const ctx = Context.user({ userId: 'user-1', authMethod: 'api_key' })

  it.each([false, true])('records an admitted checkpoint request even when waiting fails: %s', async (waitFails) => {
    const observed: Readonly<Record<string, string>>[] = []
    const dispose = subscribeBusinessEvents((event) => observed.push(event))
    const recovery = { createBox: jest.fn().mockResolvedValue(startedBox) }
    const waiter = { waitForStarted: jest.fn().mockResolvedValue(startedBox) }
    if (waitFails) waiter.waitForStarted.mockRejectedValue(new Error('wait failed'))
    const controller = new BoxliteBoxController(
      {} as never,
      waiter as never,
      { resolveMaxCreatedBoxes: async () => 3 } as never,
      recovery as never,
    )
    try {
      await controller.createBox(authContext as never, { checkpoint_id: 'base' } as never, ctx).catch(() => undefined)
      expect(observed).toEqual([
        expect.objectContaining({
          'event.name': 'box.create',
          'event.outcome': 'requested',
          'correlation.id': startedBox.id,
        }),
      ])
      expect(observed[0]).toMatchObject({ 'user.id': 'user-1' })
      observed.length = 0
      recovery.createBox.mockRejectedValue(new Error('admission failed'))
      await expect(
        controller.createBox(authContext as never, { checkpoint_id: 'base' } as never, ctx),
      ).rejects.toThrow()
      expect(observed).toEqual([])
    } finally {
      dispose()
    }
  })

  it('creates, starts, stops and deletes a box as the calling user', async () => {
    const { controller, boxService } = makeController()

    await controller.createBox(authContext as never, { image: 'boxlite/base' } as never, ctx)
    await controller.startBox(authContext as never, 'box-1', ctx)
    await controller.stopBox(authContext as never, 'box-1', ctx)
    await controller.removeBox(authContext as never, 'box-1', ctx)

    expect(boxService.create).toHaveBeenCalledWith(expect.anything(), organization, ctx, expect.anything())
    expect(boxService.start).toHaveBeenCalledWith('box-1', organization, ctx, { idOnly: true })
    expect(boxService.stop).toHaveBeenCalledWith('box-1', organization.id, ctx)
    expect(boxService.destroy).toHaveBeenCalledWith('box-1', organization.id, ctx)
  })
})

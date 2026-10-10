/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { currentLogContext } from '../common/utils/business-event-context'

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
  // The log context each BoxService call ran in, read the way BoxService reads it.
  const contexts: Record<string, unknown> = {}
  const recordContext = (method: string, result: unknown) =>
    jest.fn(async () => {
      contexts[method] = currentLogContext()
      return result
    })
  const boxService = {
    create: recordContext('create', startedBox),
    destroy: recordContext('destroy', startedBox),
    stop: recordContext('stop', startedBox),
    toBoxDto: jest.fn().mockResolvedValue(startedBox),
  }
  const commerceBoxLimitService = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
  const controller = new BoxliteBoxController(boxService as never, {} as never, commerceBoxLimitService as never)
  return { controller, contexts }
}

describe('BoxliteBoxController business event actor', () => {
  it('creates, stops and deletes a box as the user', async () => {
    const { controller, contexts } = makeController()

    await controller.createBox(authContext as never, { image: 'boxlite/base' } as never)
    await controller.stopBox(authContext as never, 'box-1')
    await controller.removeBox(authContext as never, 'box-1')

    expect(contexts).toEqual({
      create: { actorKind: 'user' },
      stop: { actorKind: 'user' },
      destroy: { actorKind: 'user' },
    })
  })
})

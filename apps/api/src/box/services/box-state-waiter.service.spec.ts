/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EventEmitter } from 'events'
import { BoxState } from '../enums/box-state.enum'
import { BoxStateWaiterService } from './box-state-waiter.service'
import { BOX_EVENT_CHANNEL } from '../../common/constants/constants'

function makeWaiter(initialState = BoxState.STARTING) {
  const subscriber = new EventEmitter() as any
  subscriber.subscribe = jest.fn().mockResolvedValue(1)
  subscriber.quit = jest.fn().mockResolvedValue(undefined)
  const redis = { duplicate: jest.fn(() => subscriber) } as any
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1', state: initialState }),
    toBoxDto: jest.fn(async (box) => box),
  } as any
  return { waiter: new BoxStateWaiterService(boxService, redis), subscriber, boxService }
}

describe('BoxStateWaiterService', () => {
  it('resolves concurrent waiters for the same box from one state event', async () => {
    const { waiter, subscriber } = makeWaiter()
    const first = waiter.waitForStarted('box-1', 'org-1', 5)
    const second = waiter.waitForStarted('box-1', 'org-1', 5)
    await new Promise((resolve) => setImmediate(resolve))

    subscriber.emit('message', BOX_EVENT_CHANNEL, JSON.stringify({ box: { id: 'box-1', state: BoxState.STARTED } }))

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'box-1', state: BoxState.STARTED },
      { id: 'box-1', state: BoxState.STARTED },
    ])
  })

  it('rejects instead of returning a non-target state on timeout', async () => {
    jest.useFakeTimers()
    const { waiter } = makeWaiter()
    const pending = expect(waiter.waitForStarted('box-1', 'org-1', 1)).rejects.toThrow(
      'Timed out waiting for box box-1 to reach started',
    )
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)

    await pending
    jest.useRealTimers()
  })
})

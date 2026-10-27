/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EventEmitter } from 'events'
import { HttpStatus, RequestTimeoutException } from '@nestjs/common'
import { BoxProgressPhase } from '../enums/box-progress-phase.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxPreparingImageTimeoutError } from '../errors/box-preparing-image-timeout.error'
import { BoxStateWaiterService } from './box-state-waiter.service'
import { BOX_EVENT_CHANNEL } from '../../common/constants/constants'

function makeWaiter(initialState = BoxState.STARTING, toBoxDto?: (box: any) => Promise<any>) {
  const subscriber = new EventEmitter() as any
  subscriber.subscribe = jest.fn().mockResolvedValue(1)
  subscriber.quit = jest.fn().mockResolvedValue(undefined)
  const redis = { duplicate: jest.fn(() => subscriber) } as any
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-1', state: initialState }),
    toBoxDto: jest.fn(toBoxDto ?? (async (box: any) => box)),
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

  /**
   * The wait is bounded here, not by the box: the pull carries on after the
   * request is answered. A caller told only "timed out" would read that as a
   * stuck box and retry straight into the same wait.
   */
  it('says what the box was waiting on when the wait ends mid-pull', async () => {
    jest.useFakeTimers()
    const progress = { phase: BoxProgressPhase.PREPARING_IMAGE, retryAfterMs: 5000 }
    const { waiter } = makeWaiter(BoxState.CREATING, async (box: any) => ({ ...box, progress }))
    const pending = waiter.waitForStarted('box-1', 'org-1', 1).catch((error) => error)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)

    const error = await pending
    expect(error).toBeInstanceOf(BoxPreparingImageTimeoutError)
    expect(error.getStatus()).toBe(HttpStatus.REQUEST_TIMEOUT)
    expect(error.getResponse()).toEqual({
      message: 'Timed out waiting for box box-1 to reach started',
      progress,
    })
    expect(error.retryAfterSeconds).toBe(5)
    jest.useRealTimers()
  })

  it('keeps the plain timeout when the box was not waiting on an image', async () => {
    jest.useFakeTimers()
    const { waiter } = makeWaiter(BoxState.STARTING)
    const pending = waiter.waitForStarted('box-1', 'org-1', 1).catch((error) => error)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)

    const error = await pending
    expect(error).toBeInstanceOf(RequestTimeoutException)
    expect(error).not.toBeInstanceOf(BoxPreparingImageTimeoutError)
    jest.useRealTimers()
  })

  /**
   * The read that enriches the failure is best-effort. Losing it must not
   * replace a timeout the caller can act on with a database error it cannot.
   */
  it('still times out when it cannot read what the box was waiting on', async () => {
    jest.useFakeTimers()
    const { waiter } = makeWaiter(BoxState.CREATING, async () => {
      throw new Error('catalog unavailable')
    })
    const pending = waiter.waitForStarted('box-1', 'org-1', 1).catch((error) => error)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(1000)

    const error = await pending
    expect(error).toBeInstanceOf(RequestTimeoutException)
    expect(error.message).toBe('Timed out waiting for box box-1 to reach started')
    jest.useRealTimers()
  })
})

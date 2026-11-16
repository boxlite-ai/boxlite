/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxCreationLimitExceededError } from '../box/errors/box-creation-limit.error'
import { Context } from '../common/context/context'
import { ReplaySession } from './box-request-replay.service'
import { randomUUID } from 'node:crypto'

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
  const requestReplay = {
    session: jest.fn().mockResolvedValue(new ReplaySession(undefined, undefined, undefined)),
  }
  const controller = new BoxliteBoxController(
    boxService as never,
    boxStateWaiter as never,
    commerceBoxLimitService as never,
    {} as never,
    requestReplay as never,
  )
  return { controller, boxService, boxStateWaiter, commerceBoxLimitService, requestReplay }
}

describe('BoxliteBoxController creation limit', () => {
  it('resolves the organization limit and passes it only to create', async () => {
    const { controller, boxService, boxStateWaiter, commerceBoxLimitService } = makeController()

    const response = await controller.createBox(
      authContext as never,
      undefined,
      { image: 'boxlite/base' } as never,
      Context.user(),
    )

    expect(commerceBoxLimitService.resolveMaxCreatedBoxes).toHaveBeenCalledWith(organization.id)
    expect(boxService.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'boxlite/base' }),
      organization,
      expect.anything(),
      { maxCreatedBoxes: 3 },
    )
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
    expect(response).toEqual(expect.objectContaining({ box_id: 'box-1', status: 'running' }))

    await controller.startBox(authContext as never, 'box-1', Context.user())
    await controller.stopBox(authContext as never, 'box-1', Context.user())
    expect(commerceBoxLimitService.resolveMaxCreatedBoxes).toHaveBeenCalledTimes(1)
  })

  it('does not persist or wait for startup when Commerce admission fails', async () => {
    const { controller, boxService, boxStateWaiter, commerceBoxLimitService } = makeController()
    commerceBoxLimitService.resolveMaxCreatedBoxes.mockRejectedValue(new Error('commerce unavailable'))

    await expect(controller.createBox(authContext as never, undefined, {} as never, Context.user())).rejects.toThrow(
      'commerce unavailable',
    )
    expect(boxService.create).not.toHaveBeenCalled()
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
  })

  it('does not wait for startup when the repository rejects at the limit', async () => {
    const { controller, boxService, boxStateWaiter } = makeController()
    boxService.create.mockRejectedValue(new BoxCreationLimitExceededError(3, 3))

    await expect(
      controller.createBox(authContext as never, undefined, {} as never, Context.user()),
    ).rejects.toBeInstanceOf(BoxCreationLimitExceededError)
    expect(boxStateWaiter.waitForStarted).not.toHaveBeenCalled()
  })

  // A wait failure after admission means the Box exists: releasing or
  // deleting the record would let a same-key retry create a second one.
  it('keeps the replay record when the state wait fails after admission', async () => {
    const key = randomUUID()
    const owner = new ReplaySession(undefined, { key: 'k', owner: 'o' }, undefined)
    const releaseSpy = jest.spyOn(owner, 'releaseSafe')
    const completeSpy = jest.spyOn(owner, 'complete')
    const { controller, boxService, boxStateWaiter } = makeController()
    boxService.create.mockResolvedValue({ ...startedBox, state: BoxState.CREATING })
    boxStateWaiter.waitForStarted.mockRejectedValue(new Error('runner never confirmed'))
    const sessionStub = { session: jest.fn().mockResolvedValue(owner) }
    const gated = new BoxliteBoxController(
      boxService as never,
      boxStateWaiter as never,
      { resolveMaxCreatedBoxes: async () => 3 } as never,
      {} as never,
      sessionStub as never,
    )

    await expect(gated.createBox(authContext as never, key, {} as never, Context.user())).rejects.toThrow(
      'runner never confirmed',
    )
    expect(completeSpy).not.toHaveBeenCalled()
    expect(releaseSpy).not.toHaveBeenCalled()
  })

  // The Notion page's four-step acceptance sequence: quota 429 → free a slot
  // → same key succeeds → full quota again, same key still replays the
  // original success. The replay service must not cache the 429 as terminal.
  it('replays the original success after a quota rejection released the slot', async () => {
    const key = randomUUID()
    const dto = { image: 'boxlite/base' } as never
    const completed = new ReplaySession(undefined, undefined, undefined)
    const ownerSessions: ReplaySession[] = []
    const requestReplay = {
      session: jest.fn(async () => {
        const session = new ReplaySession(
          undefined,
          { key: `k:${ownerSessions.length}`, owner: `o${ownerSessions.length}` },
          undefined,
        )
        ownerSessions.push(session)
        return session
      }),
    }
    const boxService = {
      create: jest.fn(),
      findOneByIdOrName: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      toBoxDto: jest.fn(),
    }
    const boxStateWaiter = { waitForStarted: jest.fn() }
    const commerceBoxLimitService = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
    const controller = new BoxliteBoxController(
      boxService as never,
      boxStateWaiter as never,
      commerceBoxLimitService as never,
      {} as never,
      requestReplay as never,
    )
    // Spy on the session methods to track completion calls through the
    // production controller path.
    for (const session of ownerSessions) {
      jest.spyOn(session, 'complete')
      jest.spyOn(session, 'releaseSafe')
    }
    const releaseSpy = jest.spyOn(ReplaySession.prototype, 'releaseSafe')
    const completeSpy = jest.spyOn(ReplaySession.prototype, 'complete')

    // Step 1: quota rejection with the key; the record must be marked retryable.
    boxService.create.mockRejectedValueOnce(new BoxCreationLimitExceededError(3, 3))
    await expect(controller.createBox(authContext as never, key, dto, Context.user())).rejects.toBeInstanceOf(
      BoxCreationLimitExceededError,
    )
    expect(completeSpy).not.toHaveBeenCalled()
    expect(releaseSpy).toHaveBeenCalledWith(true)

    // Step 2 (implicit: a slot was freed). Same key now succeeds.
    boxService.create.mockResolvedValueOnce(startedBox)
    const response = await controller.createBox(authContext as never, key, dto, Context.user())
    expect(response.box_id).toBe(startedBox.id)
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 201 }))

    // Step 3: the quota is full again; a new key V is rejected normally.
    boxService.create.mockRejectedValueOnce(new BoxCreationLimitExceededError(3, 3))
    await expect(controller.createBox(authContext as never, randomUUID(), dto, Context.user())).rejects.toBeInstanceOf(
      BoxCreationLimitExceededError,
    )

    // Step 4: the same key U now replays the stored success without calling create again.
    const replayedSession = new ReplaySession(
      { status: 201, body: JSON.stringify({ box_id: startedBox.id }) },
      undefined,
      undefined,
    )
    requestReplay.session.mockResolvedValueOnce(replayedSession)
    const createCallsBefore = boxService.create.mock.calls.length
    const replayed = await controller.createBox(authContext as never, key, dto, Context.user())
    expect(replayed.box_id).toBe(startedBox.id)
    expect(boxService.create.mock.calls.length).toBe(createCallsBefore)
  })
})

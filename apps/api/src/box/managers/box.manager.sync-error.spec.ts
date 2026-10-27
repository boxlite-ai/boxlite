/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxManager } from './box.manager'

const BOX = {
  id: 'box-1',
  organizationId: 'org-1',
  image: 'quay.io/acme/app:v1',
  state: BoxState.CREATING,
  desiredState: BoxDesiredState.STARTED,
  runnerId: null,
}

function makeManager(startFailure: Error) {
  const boxRepository = {
    findOneOrFail: jest.fn().mockResolvedValue({ ...BOX }),
    updateWhere: jest.fn().mockResolvedValue(undefined),
  }
  const imagePullFailureService = { reasonFor: jest.fn().mockResolvedValue('explained') }
  const manager = new BoxManager(
    boxRepository as never,
    {} as never,
    {} as never,
    { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) } as never,
    { run: jest.fn().mockRejectedValue(startFailure) } as never,
    {} as never,
    {} as never,
    imagePullFailureService as never,
  )
  return { manager, boxRepository, imagePullFailureService }
}

describe('BoxManager sync errors', () => {
  /**
   * A runner that pulls while it answers the create call, rather than in a
   * job, fails the call itself, and this is where that failure is recorded.
   * It gets the same explanation a failed job would.
   */
  it('records the explained reason when starting a box fails', async () => {
    const failure = 'failed to pull manifest [MANIFEST_UNKNOWN]: manifest unknown'
    const { manager, boxRepository, imagePullFailureService } = makeManager(new Error(failure))

    await manager.syncInstanceState(BOX.id)

    expect(imagePullFailureService.reasonFor).toHaveBeenCalledWith(expect.objectContaining({ id: BOX.id }), failure)
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      BOX.id,
      expect.objectContaining({
        updateData: expect.objectContaining({ state: BoxState.ERROR, errorReason: 'explained' }),
      }),
    )
  })
})

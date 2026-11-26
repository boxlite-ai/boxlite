/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxEvents } from '../constants/box-events.constants'
import { Context } from '../../common/context/context'

jest.mock('../utils/box-business-event.util', () => ({ recordBoxRequested: jest.fn() }))

function makeDestroyService(box: any) {
  const updatedBox = { ...box, desiredState: BoxDesiredState.DESTROYED }
  const boxRepository = {
    findWithCheckpointState: jest.fn().mockResolvedValue({ box, checkpointState: null }),
    updateWhere: jest.fn().mockResolvedValue(updatedBox),
  }
  const eventEmitter = { emit: jest.fn() }
  const service = Object.create(BoxService.prototype) as BoxService
  Object.assign(service as any, {
    findOneByIdOrName: jest.fn().mockResolvedValue(box),
    boxRepository,
    eventEmitter,
  })
  return { service, boxRepository, eventEmitter, updatedBox }
}

const waitingRestart = {
  id: 'box-1',
  name: 'box-1',
  organizationId: 'org-1',
  state: BoxState.STOPPED,
  desiredState: BoxDesiredState.STARTED,
  pending: true,
}

describe('BoxService Filestore restart deletion', () => {
  it('deletes a stopped Filestore Box without resolving its missing instance', async () => {
    const filestoreInstanceResolver = { resolve: jest.fn() }
    const { service, boxRepository, eventEmitter, updatedBox } = makeDestroyService({
      ...waitingRestart,
      volumes: [
        {
          volumeId: 'volume-1',
          mountPath: '/data',
          filestore: { instance: 'removed-instance', server: '10.0.0.7', export: '/vol1' },
        },
      ],
    })
    Object.assign(service as any, { filestoreInstanceResolver })

    await expect(service.destroy('box-1', 'org-1', Context.user())).resolves.toBe(updatedBox)
    expect(boxRepository.updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: expect.objectContaining({ desiredState: BoxDesiredState.DESTROYED, pending: true }),
      whereCondition: { pending: true, state: BoxState.STOPPED },
    })
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxEvents.DESTROYED, expect.anything())
    expect(filestoreInstanceResolver.resolve).not.toHaveBeenCalled()
  })

  it('keeps rejecting other pending restarts', async () => {
    const { service, boxRepository, eventEmitter } = makeDestroyService({
      ...waitingRestart,
      volumes: [{ volumeId: 'volume-1', mountPath: '/data' }],
    })

    await expect(service.destroy('box-1', 'org-1', Context.user())).rejects.toThrow('Box state change in progress')
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
    expect(eventEmitter.emit).not.toHaveBeenCalled()
  })
})

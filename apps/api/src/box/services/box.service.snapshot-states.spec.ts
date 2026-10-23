/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxService } from './box.service'

function heldBox(state: BoxState): Box {
  const box = new Box('us', 'held')
  box.state = state
  box.desiredState = BoxDesiredState.STOPPED
  box.pending = false
  return box
}

function serviceFor(box: Box) {
  const service = Object.create(BoxService.prototype) as BoxService
  const updateWhere = jest.fn()
  const update = jest.fn()
  const replaceOutbound = jest.fn()
  ;(service as any).findOneByIdOrName = jest.fn().mockResolvedValue(box)
  ;(service as any).resolveOutboundAllowNet = jest.fn((allowNet: string[] | undefined) => allowNet)
  ;(service as any).regionService = { findOne: jest.fn().mockResolvedValue({ id: 'us' }) }
  ;(service as any).boxRepository = { updateWhere, update, replaceOutbound }
  return { service, writes: [updateWhere, update, replaceOutbound] }
}

// Every change a caller can ask of a box, other than deleting it.
const CHANGES: [string, (service: BoxService) => Promise<unknown>][] = [
  ['start', (service) => service.start('box-1', { id: 'org-1' } as never)],
  ['stop', (service) => service.stop('box-1', 'org-1', {} as never)],
  ['replace labels', (service) => service.replaceLabels('box-1', { team: 'a' }, 'org-1')],
  ['set the auto-stop interval', (service) => service.setAutostopInterval('box-1', 30, 'org-1')],
  ['set the auto-delete interval', (service) => service.setAutoDeleteInterval('box-1', 30, 'org-1')],
  ['change inbound access', (service) => service.updateInboundEnabled('box-1', true, 'org-1')],
  ['change network settings', (service) => service.updateNetworkSettings('box-1', false, undefined, 'org-1')],
  [
    'replace the outbound policy',
    (service) => service.setOutboundNetwork('box-1', { mode: 'enabled', allow_net: [] } as never, 'org-1'),
  ],
]

// A snapshot job holds the box until it settles, so every change but deletion
// answers 409, rather than the 400 a box merely in transition gets, and
// writes nothing.
describe('BoxService and a box held by a snapshot job', () => {
  describe.each([BoxState.EXPORTING, BoxState.IMPORTING])('%s', (state) => {
    it.each(CHANGES)('refuses to %s', async (_change, attempt) => {
      const { service, writes } = serviceFor(heldBox(state))

      const refusal = attempt(service)

      await expect(refusal).rejects.toThrow(ConflictException)
      await expect(refusal).rejects.toThrow(/snapshot/)
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled()
      }
    })
  })
})

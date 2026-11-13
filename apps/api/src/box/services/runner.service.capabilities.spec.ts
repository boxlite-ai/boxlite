/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { validateSync } from 'class-validator'
import { RunnerService } from './runner.service'
import { RunnerHealthcheckDto } from '../dto/runner-health.dto'
import { RunnerState } from '../enums/runner-state.enum'

describe('Runner capability declarations', () => {
  it.each([[undefined], [['filestore']], [[]]] as [string[] | undefined][])(
    'persists declaration %p verbatim, absent as null',
    async (capabilities) => {
      const service = Object.create(RunnerService.prototype) as RunnerService
      const write = jest.fn().mockResolvedValue(true)
      Object.assign(service, {
        logger: { debug: jest.fn() },
        findOne: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }),
        updateRunnerUnlessDecommissioned: write,
        eventEmitter: { emit: jest.fn() },
      })
      await service.updateRunnerHealth('runner', undefined, undefined, undefined, undefined, undefined, 'dev', false, {
        capabilities,
      })
      expect(write).toHaveBeenCalledWith(
        'runner',
        expect.objectContaining({
          capabilities: capabilities ?? null,
        }),
      )
    },
  )

  it('does not replace capabilities after an info-read failure', async () => {
    const service = Object.create(RunnerService.prototype) as RunnerService
    const write = jest.fn().mockResolvedValue(true)
    Object.assign(service, {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }),
      updateRunnerUnlessDecommissioned: write,
      eventEmitter: { emit: jest.fn() },
    })
    await service.updateRunnerHealth(
      'runner',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { infoFailed: true, capabilities: ['filestore'] },
    )
    expect(write.mock.calls[0][1]).not.toHaveProperty('capabilities')
  })

  it.each([null, 'filestore', 1, ['filestore', 1]])('rejects invalid capabilities %p on the heartbeat boundary', (value) => {
    const dto = Object.assign(new RunnerHealthcheckDto(), {
      appVersion: 'dev',
      capabilities: value,
    })
    expect(validateSync(dto).map((error) => error.property)).toEqual(
      expect.arrayContaining(['capabilities']),
    )
  })
})

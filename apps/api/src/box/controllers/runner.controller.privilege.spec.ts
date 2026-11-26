/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerController } from './runner.controller'
import { RunnerHealthcheckDto } from '../dto/runner-health.dto'

describe('RunnerController privilege heartbeat', () => {
  it.each([undefined, false, true])(
    'forwards reported privilege support %s to health persistence',
    async (supportsPrivileged) => {
      const updateRunnerHealth = jest.fn().mockResolvedValue(undefined)
      const controller = Object.create(RunnerController.prototype) as RunnerController
      Object.assign(controller, { runnerService: { updateRunnerHealth } })
      const report = Object.assign(new RunnerHealthcheckDto(), { appVersion: 'dev', supportsPrivileged })

      await controller.runnerHealthcheck({ runnerId: 'runner-1' } as any, report, { headers: {} })

      expect(updateRunnerHealth).toHaveBeenCalledWith(
        'runner-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'dev',
        supportsPrivileged,
        { nestedVirtualizationEnabled: undefined, protectedProcessId: null },
        undefined,
      )
    },
  )

  it.each([
    ['fa6b7e3a-405c-45ca-b57e-7cb256e7bc58', 'fa6b7e3a-405c-45ca-b57e-7cb256e7bc58'],
    ['invalid', null],
  ] as const)('persists the current Runner process for header %s', async (header, processId) => {
    const updateRunnerHealth = jest.fn().mockResolvedValue(undefined)
    const controller = Object.create(RunnerController.prototype) as RunnerController
    Object.assign(controller, { runnerService: { updateRunnerHealth } })

    await controller.runnerHealthcheck({ runnerId: 'runner-1' } as any, new RunnerHealthcheckDto(), {
      headers: { 'x-boxlite-runner-process': header },
    })

    expect(updateRunnerHealth.mock.calls[0][8]).toEqual({
      nestedVirtualizationEnabled: undefined,
      protectedProcessId: processId,
    })
  })
})

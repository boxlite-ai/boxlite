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

      await controller.runnerHealthcheck({ runnerId: 'runner-1' } as any, report)

      expect(updateRunnerHealth).toHaveBeenCalledWith(
        'runner-1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'dev',
        supportsPrivileged,
        { nestedVirtualizationEnabled: undefined },
        // An absent identity field is the runner saying it has no disk to
        // advertise, so it reaches persistence as an explicit null (clear);
        // the poller caller passes undefined and keeps whatever is stored.
        null,
      )
    },
  )

  it('forwards a reported data disk identity unchanged', async () => {
    const updateRunnerHealth = jest.fn().mockResolvedValue(undefined)
    const controller = Object.create(RunnerController.prototype) as RunnerController
    Object.assign(controller, { runnerService: { updateRunnerHealth } })
    const identity = { provider: 'gcp', project: 'p', zone: 'z', diskName: 'disk-1' }
    const report = Object.assign(new RunnerHealthcheckDto(), { appVersion: 'dev', dataDiskRef: identity })

    await controller.runnerHealthcheck({ runnerId: 'runner-1' } as any, report)

    expect(updateRunnerHealth).toHaveBeenCalledWith(
      'runner-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'dev',
      undefined,
      { nestedVirtualizationEnabled: undefined },
      identity,
    )
  })
})

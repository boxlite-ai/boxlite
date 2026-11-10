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
        undefined,
        undefined,
      )
    },
  )
})

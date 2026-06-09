/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AdminRunnerController } from './runner.controller'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-test'),
  validate: jest.fn(() => true),
}))

describe('AdminRunnerController', () => {
  function buildController() {
    const runnerService = {
      findOneFullOrFail: jest.fn().mockResolvedValue({
        id: 'runner-1',
        state: 'ready',
        apiKey: 'runner-secret-key',
      }),
      findAllFull: jest.fn().mockResolvedValue([
        {
          id: 'runner-1',
          state: 'ready',
          apiKey: 'runner-secret-key',
        },
      ]),
      findAllByRegionFull: jest.fn().mockResolvedValue([
        {
          id: 'runner-1',
          state: 'ready',
          apiKey: 'runner-secret-key',
        },
      ]),
    }
    const regionService = {
      findOne: jest.fn(),
    }

    return {
      runnerService,
      controller: new AdminRunnerController(runnerService as any, regionService as any),
    }
  }

  it('redacts runner api keys from list and detail responses', async () => {
    const { controller } = buildController()

    const detail = await controller.getRunnerById('00000000-0000-4000-8000-000000000000')
    const list = await controller.findAll()
    const regionalList = await controller.findAll('us')

    expect(detail).not.toHaveProperty('apiKey')
    expect(list[0]).not.toHaveProperty('apiKey')
    expect(regionalList[0]).not.toHaveProperty('apiKey')
    expect(JSON.stringify({ detail, list, regionalList })).not.toContain('runner-secret-key')
  })
})

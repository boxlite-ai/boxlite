/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxClass } from '../../box/enums/box-class.enum'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { AdminOverviewService } from './overview.service'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-test'),
  validate: jest.fn(() => true),
}))

describe('AdminOverviewService', () => {
  function buildService(runners: any[] = [], drainingRunners: any[] = []) {
    const runnerService = {
      findAllFull: jest.fn().mockResolvedValue(runners),
      findDrainingPaginated: jest.fn().mockResolvedValue(drainingRunners),
    }

    return {
      runnerService,
      service: new AdminOverviewService({} as any, runnerService as any, {} as any, {} as any),
    }
  }

  it('does not expose runner api keys in Admin runner items', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z')
    const { service } = buildService([
      {
        id: 'runner-1',
        domain: 'runner.example.com',
        apiUrl: 'https://runner.example.com',
        proxyUrl: 'https://proxy.runner.example.com',
        apiKey: 'runner-secret-key',
        cpu: 4,
        memoryGiB: 8,
        diskGiB: 100,
        gpu: 0,
        gpuType: '',
        class: BoxClass.SMALL,
        currentCpuUsagePercentage: 1,
        currentMemoryUsagePercentage: 2,
        currentDiskUsagePercentage: 3,
        currentAllocatedCpu: 1,
        currentAllocatedMemoryGiB: 1,
        currentAllocatedDiskGiB: 1,
        currentStartedBoxes: 0,
        availabilityScore: 100,
        region: 'us',
        name: 'runner-1',
        state: RunnerState.READY,
        lastChecked: now,
        unschedulable: false,
        createdAt: now,
        updatedAt: now,
        apiVersion: '0',
        appVersion: 'v0.0.0-dev',
      },
    ])

    const runners = await service.listRunners()

    expect(runners).toHaveLength(1)
    expect(runners[0]).toMatchObject({
      id: 'runner-1',
      state: RunnerState.READY,
      draining: false,
    })
    expect(runners[0]).not.toHaveProperty('apiKey')
    expect(JSON.stringify(runners[0])).not.toContain('runner-secret-key')
  })
})

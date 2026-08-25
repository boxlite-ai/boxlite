/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../box/entities/box.entity'
import { Runner } from '../box/entities/runner.entity'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { RunnerState } from '../box/enums/runner-state.enum'
import { toBackofficeBoxSummary, toBackofficeRunnerSummary } from './backoffice-inventory.mapper'

const CREATED_AT = new Date('2026-08-24T10:00:00.000Z')
const UPDATED_AT = new Date('2026-08-25T10:00:00.000Z')

describe('Backoffice internal inventory redaction', () => {
  it('maps a Box through an explicit operational allowlist', () => {
    const box = {
      id: 'AbCdEf123456',
      organizationId: '11111111-1111-4111-8111-111111111111',
      name: 'safe-box-name',
      region: 'us-east',
      runnerId: '22222222-2222-4222-8222-222222222222',
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTED,
      cpu: 2,
      mem: 4,
      disk: 10,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      authToken: 'synthetic-box-auth-token',
      env: { SYNTHETIC_PASSWORD: 'synthetic-password-value' },
      labels: { confidential: 'synthetic-sensitive-label' },
      networkAllowList: '10.0.0.0/8',
      volumes: [{ volumeId: 'volume-1', mountPath: '/synthetic-private-path' }],
      errorReason: 'synthetic-raw-error',
    } as unknown as Box

    const result = toBackofficeBoxSummary(box, 3)

    expect(result).toEqual({
      id: 'AbCdEf123456',
      name: 'safe-box-name',
      organizationId: '11111111-1111-4111-8111-111111111111',
      runnerId: '22222222-2222-4222-8222-222222222222',
      regionId: 'us-east',
      desiredState: BoxDesiredState.STARTED,
      observedState: BoxState.STARTED,
      resources: {
        cpuMillis: 2000,
        memoryBytes: '4294967296',
        storageBytes: '10737418240',
      },
      activeJobCount: 3,
      observedAt: UPDATED_AT.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
    })
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      box.authToken,
      'synthetic-password-value',
      'synthetic-sensitive-label',
      box.networkAllowList,
      '/synthetic-private-path',
      box.errorReason,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('maps a Runner without credentials, internal origins, or raw health errors', () => {
    const runner = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'runner-a',
      region: 'us-east',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      apiVersion: '2',
      appVersion: 'v0.9.7',
      cpu: 8,
      memoryGiB: 16,
      diskGiB: 100,
      currentAllocatedCpu: 3,
      currentAllocatedMemoryGiB: 5,
      currentAllocatedDiskGiB: 20,
      currentCpuUsagePercentage: 37.5,
      currentMemoryUsagePercentage: 42,
      currentDiskUsagePercentage: 21,
      currentStartedBoxes: 4,
      availabilityScore: 91,
      lastChecked: UPDATED_AT,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      apiKey: 'synthetic-runner-api-key',
      domain: 'synthetic.internal.example',
      apiUrl: 'https://synthetic-api.internal.example',
      proxyUrl: 'https://synthetic-proxy.internal.example',
      serviceHealth: [{ serviceName: 'daemon', healthy: false, errorReason: 'synthetic-service-error' }],
    } as unknown as Runner

    const result = toBackofficeRunnerSummary(runner, {
      boxCount: 7,
      activeJobCount: 2,
      queueDepth: 1,
    })

    expect(result).toEqual({
      id: runner.id,
      name: 'runner-a',
      regionId: 'us-east',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      versions: { api: '2', app: 'v0.9.7' },
      capacity: {
        cpuMillis: 8000,
        memoryBytes: '17179869184',
        storageBytes: '107374182400',
      },
      allocated: {
        cpuMillis: 3000,
        memoryBytes: '5368709120',
        storageBytes: '21474836480',
      },
      usage: { cpuPercentage: 37.5, memoryPercentage: 42, storagePercentage: 21 },
      boxCount: 7,
      startedBoxCount: 4,
      activeJobCount: 2,
      queueDepth: 1,
      availabilityScore: 91,
      lastHeartbeatAt: UPDATED_AT.toISOString(),
      observedAt: UPDATED_AT.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
    })
    const serialized = JSON.stringify(result)
    for (const forbidden of [runner.apiKey, runner.domain, runner.apiUrl, runner.proxyUrl, 'synthetic-service-error']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})

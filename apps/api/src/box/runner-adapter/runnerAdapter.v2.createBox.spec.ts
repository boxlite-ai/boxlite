/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }))

import { Box } from '../entities/box.entity'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

function createAdapter(createJob: jest.Mock): RunnerAdapterV2 {
  const adapter = Object.create(RunnerAdapterV2.prototype) as RunnerAdapterV2
  ;(adapter as any).jobService = { createJob }
  ;(adapter as any).runner = { id: 'runner-1' }
  ;(adapter as any).logger = { debug: jest.fn() }
  return adapter
}

describe('RunnerAdapterV2.createBox (CREATE_BOX job payload)', () => {
  const ARTIFACT_REF = 'ghcr.io/boxlite-ai/boxlite-agent-base@sha256:deadbeef'

  function buildBox(): Box {
    const box = new Box('us', 'data-loader')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'root'
    box.cpu = 2
    box.mem = 4
    box.disk = 10
    box.gpu = 0
    return box
  }

  it('enqueues a CREATE_BOX / BOX job for the box on its runner', async () => {
    const createJob = jest.fn().mockResolvedValue(undefined)
    const adapter = createAdapter(createJob)
    const box = buildBox()

    await adapter.createBox(box, ARTIFACT_REF)

    expect(createJob).toHaveBeenCalledTimes(1)
    const [, jobType, runnerId, resourceType, resourceId] = createJob.mock.calls[0]
    expect(jobType).toBe(JobType.CREATE_BOX)
    expect(resourceType).toBe(ResourceType.BOX)
    expect(runnerId).toBe('runner-1')
    expect(resourceId).toBe(box.id)
  })

  it('passes the image ref under `artifactRef` and NOT `snapshot` (Go validate:"required" trap)', async () => {
    const createJob = jest.fn().mockResolvedValue(undefined)
    const adapter = createAdapter(createJob)
    const box = buildBox()

    await adapter.createBox(box, ARTIFACT_REF)

    const payload = createJob.mock.calls[0][5] as Record<string, unknown>
    expect(payload.artifactRef).toBe(ARTIFACT_REF)
    expect('snapshot' in payload).toBe(false)
    // resources must reach the runner so the VM is sized correctly
    expect(payload.cpuQuota).toBe(2)
    expect(payload.memoryQuota).toBe(4)
    expect(payload.storageQuota).toBe(10)
  })
})

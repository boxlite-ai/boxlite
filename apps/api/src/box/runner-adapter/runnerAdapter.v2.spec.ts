/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MIN_CPUS } from '@boxlite-ai/resource-limits'

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 createBox', () => {
  it.each([MIN_CPUS, MIN_CPUS + 0.001, 1.001, 1.5, 16])('preserves %s CPUs in the create job', async (cpu) => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1' } as any)

    await adapter.createBox({ id: 'box-cpu', cpu } as any, 'base')

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-cpu',
      expect.objectContaining({ cpuQuota: cpu }),
    )
  })
  it.each([false, true])('forwards persisted guest privilege %s to the create job', async (privileged) => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1', supportsPrivileged: true } as any)

    await adapter.createBox({ id: 'box-1', image: 'base', privileged } as any, 'base')

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ privileged }),
    )
  })

  it.each([undefined, false])('rejects privileged create when runner support is %s', async (supportsPrivileged) => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1', supportsPrivileged } as any)

    await expect(adapter.createBox({ id: 'box-1', privileged: true } as any, 'base')).rejects.toThrow(
      'does not support privileged',
    )
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('passes secrets through to the CREATE_BOX job payload', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1' } as any)

    const box = {
      id: 'box-1',
      image: 'base',
      osUser: 'boxlite',
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 3,
      volumes: [],
      secrets: [
        { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
      ],
      outboundEnabled: true,
      outboundAllowNet: undefined,
      authToken: undefined,
      organizationId: undefined,
      region: undefined,
    } as any

    await adapter.createBox(box, 'base')

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({
        secrets: [
          { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
        ],
      }),
    )
  })

  /** The caller may pin a curated tag to the build this runner already has. */
  it('sends the image it is handed rather than the one on the box', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1' } as any)
    const pinned = `ghcr.io/boxlite-ai/boxlite-agent-base@sha256:${'a'.repeat(64)}`

    await adapter.createBox({ id: 'box-1', image: 'base' } as any, pinned)

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ image: pinned }),
    )
  })

  it('puts the outbound policy in the CREATE_BOX job payload as the enabled flag and entries', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    await adapter.init({ id: 'runner-1' } as any)

    await adapter.createBox(
      {
        id: 'box-1',
        image: 'base',
        volumes: [],
        outboundEnabled: true,
        outboundAllowNet: ['api.openai.com'],
      } as any,
      'base',
    )

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({ outboundEnabled: true, outboundAllowNet: ['api.openai.com'] }),
    )
    expect(jobService.createJob.mock.calls[0][5]).not.toHaveProperty('networkBlockAll')
  })
})

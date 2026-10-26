/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { BoxSnapshot } from '../entities/box-snapshot.entity'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'

describe('RunnerAdapterV2 createBox', () => {
  it('resolves a child box archive from a ready snapshot in its organization', async () => {
    const findOneByOrFail = jest.fn().mockResolvedValue({ archiveUri: 'gs://snapshots/org-1/snap-1.tar.zst' })
    const jobs = { createJob: jest.fn() }
    const adapter = new RunnerAdapterV2({ manager: { findOneByOrFail } } as any, {} as any, jobs as any)
    await adapter.init({ id: 'runner-1' } as any)

    await adapter.createBox({ id: 'child', organizationId: 'org-1', initialSnapshotId: 'snap-1' } as any, 'base')

    expect(findOneByOrFail).toHaveBeenCalledWith(BoxSnapshot, {
      id: 'snap-1',
      organizationId: 'org-1',
      state: BoxSnapshotState.READY,
    })
    expect(jobs.createJob.mock.calls[0][5].snapshotArchiveUri).toBe('gs://snapshots/org-1/snap-1.tar.zst')
  })

  it('does not dispatch a child box without a stored archive', async () => {
    const jobs = { createJob: jest.fn() }
    const repository = { manager: { findOneByOrFail: jest.fn().mockResolvedValue({ archiveUri: null }) } }
    const adapter = new RunnerAdapterV2(repository as any, {} as any, jobs as any)
    await adapter.init({ id: 'runner-1' } as any)

    await expect(adapter.createBox({ id: 'child', initialSnapshotId: 'snap-1' } as any, 'base')).rejects.toThrow(
      'Snapshot has no archive',
    )
    expect(jobs.createJob).not.toHaveBeenCalled()
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

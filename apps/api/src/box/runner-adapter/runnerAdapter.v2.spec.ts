/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { BoxState } from '../enums/box-state.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxStateWaiterService } from '../services/box-state-waiter.service'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 createBox', () => {
  it.each([0.125, 0.126, 1.001, 1.5, 16])('preserves %s CPUs in the create job', async (cpu) => {
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

  it.each([undefined, [], ['gpu-passthrough']])(
    'rejects a filestore volume create when the runner declared capabilities %p',
    async (capabilities) => {
      const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
      const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
      Object.assign(adapter as any, {
        runnerRepository: { findOne: jest.fn().mockResolvedValue({ id: 'runner-1', capabilities }) },
      })
      await adapter.init({ id: 'runner-1', capabilities } as any)

      await expect(
        adapter.createBox(
          {
            id: 'box-1',
            volumes: [
              {
                volumeId: 'vol-1',
                mountPath: '/data',
                filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
              },
            ],
          } as any,
          'base',
        ),
      ).rejects.toThrow('requires a runner with the filestore capability')
      expect(jobService.createJob).not.toHaveBeenCalled()
    },
  )

  it('uses the latest persisted capability instead of a stale scheduling snapshot', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const runnerRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'runner-1', capabilities: ['filestore'] }),
    }
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    Object.assign(adapter as any, { runnerRepository })
    await adapter.init({ id: 'runner-1', capabilities: null } as any)

    await adapter.createBox(
      {
        id: 'box-1',
        volumes: [
          {
            volumeId: 'vol-1',
            mountPath: '/data',
            filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
          },
        ],
      } as any,
      'base',
    )

    expect(runnerRepository.findOne).toHaveBeenCalledWith({ where: { id: 'runner-1' }, cache: false })
    expect(jobService.createJob).toHaveBeenCalled()
  })

  it('returns capability diagnostics through the new-Box error response', async () => {
    const lastChecked = new Date('2026-11-14T02:00:00Z')
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    Object.assign(adapter as any, {
      runnerRepository: {
        findOne: jest.fn().mockResolvedValue({
          id: 'runner-1',
          state: 'ready',
          apiVersion: '2',
          appVersion: '0.13.1+abc123',
          capabilities: ['gpu-passthrough'],
          lastChecked,
        }),
      },
    })
    await adapter.init({ id: 'runner-1', capabilities: null } as any)

    const failure = await adapter
      .createBox(
        {
          id: 'box-1',
          volumes: [
            {
              volumeId: 'vol-1',
              mountPath: '/data',
              filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
            },
          ],
        } as any,
        'base',
      )
      .catch((error) => error)
    const { errorReason } = sanitizeBoxError(failure)
    const subscriber = { on: jest.fn(), subscribe: jest.fn().mockResolvedValue(undefined) }
    const waiter = new BoxStateWaiterService(
      {
        findOneByIdOrName: jest.fn().mockResolvedValue({
          id: 'box-1',
          state: BoxState.ERROR,
          errorReason,
        }),
      } as any,
      { duplicate: jest.fn(() => subscriber) } as any,
    )

    const response = await waiter.waitForStarted('box-1', 'org-1', 1).catch((error) => error)
    const body = response.getResponse()
    expect(body).toMatchObject({ boxId: 'box-1', code: 'BOX_STATE_TRANSITION_FAILED' })
    for (const detail of [
      'runnerRecordFound=true',
      'runnerState=ready',
      'apiVersion=2',
      'appVersion=0.13.1+abc123',
      'capabilities=["gpu-passthrough"]',
      'volumeIds=["vol-1"]',
      'filestoreInstances=["ml-scratch"]',
      `lastChecked=${lastChecked.toISOString()}`,
      'lastHealthcheckAgeSeconds=',
      'No CREATE_BOX job was dispatched',
      'FILESTORE_CAPABILITY_MISSING',
    ]) {
      expect(body.message).toContain(detail)
    }
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('dispatches a filestore volume when the runner declared the capability', async () => {
    const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
    Object.assign(adapter as any, {
      runnerRepository: { findOne: jest.fn().mockResolvedValue({ id: 'runner-1', capabilities: ['filestore'] }) },
    })
    await adapter.init({ id: 'runner-1', capabilities: ['filestore'] } as any)

    await adapter.createBox(
      {
        id: 'box-1',
        volumes: [
          {
            volumeId: 'vol-1',
            mountPath: '/data',
            filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
          },
        ],
      } as any,
      'base',
    )

    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.CREATE_BOX,
      'runner-1',
      ResourceType.BOX,
      'box-1',
      expect.objectContaining({
        volumes: [
          expect.objectContaining({
            volumeId: 'vol-1',
            filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
          }),
        ],
      }),
    )
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
        {
          name: 'openai',
          value: 'sk-test',
          hosts: ['api.openai.com'],
          placeholder: '<BOXLITE_SECRET:openai>',
          headers: { 'x-api-key': '{value}' },
        },
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
          {
            name: 'openai',
            value: 'sk-test',
            hosts: ['api.openai.com'],
            placeholder: '<BOXLITE_SECRET:openai>',
            headers: { 'x-api-key': '{value}' },
          },
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

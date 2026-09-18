/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('RunnerAdapterV2 createBox', () => {
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
      networkBlockAll: false,
      networkAllowList: undefined,
      authToken: undefined,
      organizationId: undefined,
      region: undefined,
    } as any

    await adapter.createBox(box)

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

  /**
   * The runner holds the operator's registry credentials and matches them by
   * host, so the control plane has to say which pulls may use them. It is the
   * only side that knows: whether a ref is one of the operator's own curated
   * images is not visible from the ref alone.
   */
  describe('anonymous pulls', () => {
    function makeAdapter() {
      const jobService = { createJob: jest.fn().mockResolvedValue(undefined) } as any
      const adapter = new RunnerAdapterV2({} as any, {} as any, jobService)
      return { adapter, jobService }
    }

    function payloadOf(jobService: any) {
      return jobService.createJob.mock.calls[0][5]
    }

    it.each([
      ['a curated short name', 'base', false],
      ['a curated ref', 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0', false],
      ['a tenant ref', 'quay.io/acme/app:v1', true],
      // The same host the operator's own images live on. Deciding by host
      // would send credentials here, which is the hole this closes.
      ['a tenant ref on a credentialed host', 'ghcr.io/acme/app:v1', true],
    ])('pulls %s anonymously: %s', async (_label, image, expected) => {
      const { adapter, jobService } = makeAdapter()
      await adapter.init({ id: 'runner-1' } as any)

      await adapter.createBox({ id: 'box-1', image, volumes: [] } as any)

      expect(payloadOf(jobService).anonymousImagePull).toBe(expected)
    })

    // The seam only: which refs need re-resolving is imageNeedsRevalidate's
    // own specification, and a curated ref is the one that must not pay for it.
    it.each([
      ['a curated name', 'base', false],
      ['a tenant tag', 'quay.io/acme/app:v1', true],
      ['a ref already pinned', `quay.io/acme/app@sha256:${'a'.repeat(64)}`, false],
    ])('asks the runner to re-resolve %s: %s', async (_label, image, expected) => {
      const { adapter, jobService } = makeAdapter()
      await adapter.init({ id: 'runner-1' } as any)

      await adapter.createBox({ id: 'box-1', image, volumes: [] } as any)

      expect(payloadOf(jobService).imageRevalidate).toBe(expected)
    })
  })
})

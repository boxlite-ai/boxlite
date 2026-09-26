/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerAdapterV0 } from './runnerAdapter.v0'

describe('RunnerAdapterV0 createBox', () => {
  it('passes secrets through to the runner create body', async () => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1.0' } })
    ;(adapter as any).boxApiClient = { create }

    const box = {
      id: 'box-1',
      image: 'base',
      osUser: 'boxlite',
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 3,
      env: {},
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

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: [
          { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
        ],
      }),
    )
  })

  // v0 only carries volumes on the recover body (create never did); the
  // mount's mode has to survive that projection like every other field.
  it('passes a read-only volume mount through to the runner recover body', async () => {
    const adapter = new RunnerAdapterV0()
    const recover = jest.fn().mockResolvedValue(undefined)
    ;(adapter as any).boxApiClient = { recover }

    const box = {
      id: 'box-1',
      image: 'base',
      osUser: 'boxlite',
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 3,
      env: {},
      volumes: [{ volumeId: 'vol-1', mountPath: '/data', subpath: 'sets/a', readOnly: true }],
      secrets: [],
      errorReason: 'crashed',
    } as any

    await adapter.recoverBox(box)

    expect(recover).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        volumes: [{ volumeId: 'vol-1', mountPath: '/data', subpath: 'sets/a', readOnly: true }],
      }),
    )
  })

  it('passes secrets through to the runner recover body', async () => {
    const adapter = new RunnerAdapterV0()
    const recover = jest.fn().mockResolvedValue(undefined)
    ;(adapter as any).boxApiClient = { recover }

    const box = {
      id: 'box-1',
      osUser: 'boxlite',
      cpu: 1,
      gpu: 0,
      mem: 1,
      disk: 3,
      env: {},
      volumes: [],
      secrets: [{ name: 'openai', value: 'sk-test' }],
      networkBlockAll: false,
      networkAllowList: undefined,
      errorReason: 'crashed',
    } as any

    await adapter.recoverBox(box)

    expect(recover).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        secrets: [{ name: 'openai', value: 'sk-test' }],
      }),
    )
  })
})

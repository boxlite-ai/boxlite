/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerAdapterV0 } from './runnerAdapter.v0'

describe('RunnerAdapterV0 createBox', () => {
  // The runner wire still speaks the flag shape; the row stores modes. The
  // polarity flip (outbound disabled -> blockAll true) and the comma join both
  // happen here, so pin them at the boundary.
  it('translates the outbound policy into the runner flag shape', async () => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1.0' } })
    ;(adapter as any).boxApiClient = { create }

    await adapter.createBox({
      id: 'box-1',
      image: 'base',
      env: {},
      outboundMode: 'disabled',
      outboundAllowNet: ['api.openai.com', '10.0.0.0/8'],
    } as any)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ networkBlockAll: true, networkAllowList: 'api.openai.com,10.0.0.0/8' }),
    )
  })

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
      outboundMode: 'enabled',
      outboundAllowNet: undefined,
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
      outboundMode: 'enabled',
      outboundAllowNet: undefined,
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

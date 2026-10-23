/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RunnerAdapterV0 } from './runnerAdapter.v0'

describe('RunnerAdapterV0 createBox', () => {
  // The runner body carries the row's outbound policy as is; the Daytona-era
  // networkBlockAll / networkAllowList pair is gone from the wire.
  it('sends the outbound policy as the enabled flag and entries', async () => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1.0' } })
    ;(adapter as any).boxApiClient = { create }

    await adapter.createBox({
      id: 'box-1',
      image: 'base',
      env: {},
      outboundEnabled: false,
      outboundAllowNet: ['api.openai.com', '10.0.0.0/8'],
    } as any, 'base')

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ outboundEnabled: false, outboundAllowNet: ['api.openai.com', '10.0.0.0/8'] }),
    )
    expect(create.mock.calls[0][0]).not.toHaveProperty('networkBlockAll')
    expect(create.mock.calls[0][0]).not.toHaveProperty('networkAllowList')
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
      outboundEnabled: true,
      outboundAllowNet: undefined,
      authToken: undefined,
      organizationId: undefined,
      region: undefined,
    } as any

    await adapter.createBox(box, 'base')

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: [
          { name: 'openai', value: 'sk-test', hosts: ['api.openai.com'], placeholder: '<BOXLITE_SECRET:openai>' },
        ],
      }),
    )
  })

  /** The caller may pin a curated tag to the build this runner already has. */
  it('sends the image it is handed rather than the one on the box', async () => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1.0' } })
    ;(adapter as any).boxApiClient = { create }
    const pinned = `ghcr.io/boxlite-ai/boxlite-agent-base@sha256:${'a'.repeat(64)}`

    await adapter.createBox({ id: 'box-1', image: 'base' } as any, pinned)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ image: pinned }))
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
      outboundEnabled: true,
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

describe('RunnerAdapterV0 updateNetworkSettings', () => {
  // The network-settings body speaks the same outbound policy as create and
  // recover; the Daytona-era flag pair is not sent.
  it('sends the outbound policy as the enabled flag and entries', async () => {
    const adapter = new RunnerAdapterV0()
    const updateNetworkSettings = jest.fn().mockResolvedValue(undefined)
    ;(adapter as any).boxApiClient = { updateNetworkSettings }

    await adapter.updateNetworkSettings('box-1', false, ['api.openai.com', '10.0.0.0/8'])

    const body = updateNetworkSettings.mock.calls[0][1]
    expect(updateNetworkSettings).toHaveBeenCalledWith('box-1', expect.anything())
    expect(body).toEqual(
      expect.objectContaining({ outboundEnabled: false, outboundAllowNet: ['api.openai.com', '10.0.0.0/8'] }),
    )
    expect(body).not.toHaveProperty('networkBlockAll')
    expect(body).not.toHaveProperty('networkAllowList')
  })
})

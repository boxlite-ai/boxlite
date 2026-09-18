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

  /**
   * The older protocol reaches the same runner and the same DTO, so it needs
   * the same credential rule. It is also the only adapter that serves box
   * recovery, so a gap here would outlive the protocol's other uses.
   */
  it.each([
    ['a curated short name', 'base', false],
    ['a tenant ref on a credentialed host', 'ghcr.io/acme/app:v1', true],
  ])('pulls %s anonymously: %s', async (_label, image, expected) => {
    const adapter = new RunnerAdapterV0()
    const create = jest.fn().mockResolvedValue({ data: { daemonVersion: '1.0' } })
    ;(adapter as any).boxApiClient = { create }

    await adapter.createBox({ id: 'box-1', image } as any)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ anonymousImagePull: expected }))
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

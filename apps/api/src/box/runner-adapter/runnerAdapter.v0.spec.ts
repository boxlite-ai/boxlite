/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { RunnerAdapterV0 } from './runnerAdapter.v0'

describe('RunnerAdapterV0 capability propagation', () => {
  function makeAdapter() {
    const boxApiClient = {
      create: jest.fn().mockResolvedValue({ data: {} }),
      recover: jest.fn().mockResolvedValue({ data: {} }),
    }
    const adapter = new RunnerAdapterV0()
    Object.assign(adapter as any, { boxApiClient })
    return { adapter, boxApiClient }
  }

  function customCapabilityBox() {
    const box = new Box('region-1', 'cap-box')
    Object.assign(box, {
      image: 'alpine:latest',
      organizationId: 'org-1',
      osUser: 'boxlite',
      advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
    })
    return box
  }

  it('forwards the capability policy on create', async () => {
    const { adapter, boxApiClient } = makeAdapter()

    await adapter.createBox(customCapabilityBox())

    expect(boxApiClient.create).toHaveBeenCalledWith(
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('forwards the capability policy on recovery', async () => {
    const { adapter, boxApiClient } = makeAdapter()
    const box = customCapabilityBox()

    await adapter.recoverBox(box)

    expect(boxApiClient.recover).toHaveBeenCalledWith(
      box.id,
      expect.objectContaining({
        advanced: { capabilities: { add: ['SYS_ADMIN'], drop: ['NET_RAW'] } },
      }),
    )
  })

  it('sends an empty policy for a box without capability overrides', async () => {
    const { adapter, boxApiClient } = makeAdapter()
    const box = customCapabilityBox()
    box.advanced = { capabilities: { add: [], drop: [] } }

    await adapter.createBox(box)

    expect(boxApiClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ advanced: { capabilities: { add: [], drop: [] } } }),
    )
  })
})

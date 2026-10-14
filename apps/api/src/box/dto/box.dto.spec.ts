/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxDto } from './box.dto'
import { NetworkMode } from '../enums/network-mode.enum'

describe('BoxDto public identity', () => {
  it('exposes a single public id without a legacy boxId alias', () => {
    const box = new Box('us', 'data-loader')
    box.organizationId = '057963b2-60ca-4356-81fc-11503e15f249'
    box.osUser = 'boxlite'

    const dto = BoxDto.fromBox(box, 'https://proxy.boxlite.dev/toolbox')

    expect(dto.id).toBe(box.id)
    expect((dto as any).boxId).toBeUndefined()
  })
})

describe('BoxDto main command exit code', () => {
  function box(): Box {
    const box = new Box('us', 'loader')
    box.id = 'box-1'
    return box
  }

  // The code is read from the runner and handed in, so this conversion's only
  // job is to keep 0 a value: it is what separates a command that succeeded
  // from one that did not.
  it.each([
    ['a main command ended by a signal', 137, 137],
    ['a main command that succeeded', 0, 0],
  ])('reports the exit code of %s', (_case, read, expected) => {
    expect(BoxDto.fromBox(box(), 'https://proxy.invalid', null, read).exitCode).toBe(expected)
  })

  // Absence is the only way to say "not recorded", and it has to survive
  // serialization as a missing field — that is what the generated clients type
  // against. A runtime that recorded none and a runner that could not be read
  // both arrive here the same way, as nothing.
  it('omits the exit code when there is none', () => {
    const dto = BoxDto.fromBox(box(), 'https://proxy.invalid', null, undefined)

    expect(dto.exitCode).toBeUndefined()
    expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('exitCode')
  })
})

describe('BoxDto network policy', () => {
  function box(inboundMode: NetworkMode, outboundMode: NetworkMode, outboundAllowNet: string[] | null): Box {
    const box = new Box('us', 'net')
    box.id = 'box-1'
    box.inboundMode = inboundMode
    box.outboundMode = outboundMode
    box.outboundAllowNet = outboundAllowNet
    return box
  }

  // `network` is the only shape of the policy; the Daytona-era flags are gone.
  it.each([
    [NetworkMode.ENABLED, NetworkMode.ENABLED, ['api.openai.com', '10.0.0.0/8']],
    [NetworkMode.DISABLED, NetworkMode.DISABLED, null],
  ])('reports inbound %s and outbound %s only under network', (inbound, outbound, allowNet) => {
    const dto = BoxDto.fromBox(box(inbound, outbound, allowNet), 'https://proxy.invalid')

    expect(dto.network).toEqual({
      outbound: { mode: outbound, allow_net: allowNet ?? [] },
      inbound: { mode: inbound, allow_net: [] },
    })
    expect(dto).not.toHaveProperty('public')
    expect(dto).not.toHaveProperty('networkBlockAll')
    expect(dto).not.toHaveProperty('networkAllowList')
  })
})

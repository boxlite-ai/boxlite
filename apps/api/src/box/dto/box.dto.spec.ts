/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxDto } from './box.dto'

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
    expect(BoxDto.fromBox(box(), 'https://proxy.invalid', { exitCode: read }).exitCode).toBe(expected)
  })

  // Absence is the only way to say "not recorded", and it has to survive
  // serialization as a missing field — that is what the generated clients type
  // against. A runtime that recorded none and a runner that could not be read
  // both arrive here the same way, as nothing.
  it('omits the exit code when there is none', () => {
    const dto = BoxDto.fromBox(box(), 'https://proxy.invalid', { exitCode: undefined })

    expect(dto.exitCode).toBeUndefined()
    expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('exitCode')
  })
})

describe('BoxDto image', () => {
  const PROXY = 'registry-proxy-abc.a.run.app'

  afterEach(() => {
    delete process.env.REGISTRY_PROXY_HOST
  })

  // A box records the proxy ref its runner pulls. Handed back as-is, a caller
  // creating another box from what it read would be refused for naming the
  // proxy, and every SDK would show the proxy as the registry.
  it('reads back the upstream ref of an image pulled through the registry proxy', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY
    const box = new Box('us', 'private')
    box.image = `${PROXY}/0aaa0000-0000-4000-8000-000000000001/ghcr.io/acme/app@sha256:${'a'.repeat(64)}`

    expect(BoxDto.fromBox(box, 'https://proxy.invalid').image).toBe(`ghcr.io/acme/app@sha256:${'a'.repeat(64)}`)
  })

  it('reads back any other image as it was recorded', () => {
    process.env.REGISTRY_PROXY_HOST = PROXY
    const box = new Box('us', 'public')
    box.image = 'quay.io/acme/app:v1'

    expect(BoxDto.fromBox(box, 'https://proxy.invalid').image).toBe('quay.io/acme/app:v1')
  })
})

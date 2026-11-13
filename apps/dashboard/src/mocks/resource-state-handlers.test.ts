/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { resourceStateHandlers } from './resource-state-handlers'

const origin = 'https://resource-preview.test'
const server = setupServer(
  ...resourceStateHandlers(`${origin}/api`),
  http.get('*', () => HttpResponse.json({ normal: true })),
)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => vi.unstubAllGlobals())
afterAll(() => server.close())

it.each(['', '?preview=fleet', '?preview=unrecognized'])('preserves normal handlers for %s', async (search) => {
  vi.stubGlobal('window', { location: { search } })
  expect(await (await fetch(`${origin}/api/images`)).json()).toEqual({ normal: true })
})

it('returns empty resource collections and keeps capabilities enabled', async () => {
  vi.stubGlobal('window', { location: { search: '?preview=resource-empty' } })
  expect(await (await fetch(`${origin}/api/images`)).json()).toEqual([])
  expect(await (await fetch(`${origin}/api/box/paginated`)).json()).toMatchObject({ items: [], total: 0 })
  expect(await (await fetch(`${origin}/v1/config`)).json()).toMatchObject({
    capabilities: { checkpoints_enabled: true, private_tunnels_enabled: true },
  })
  expect(await (await fetch(`${origin}/v1/mock-org/domains`)).json()).toMatchObject({ domains: [], remaining: 5 })
})

it('returns failures across resource families only when explicitly selected', async () => {
  vi.stubGlobal('window', { location: { search: '?preview=resource-error' } })
  for (const path of ['/api/images', '/api/volumes', '/v1/mock-org/checkpoints', '/v1/mock-org/ci/runners']) {
    const response = await fetch(`${origin}${path}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ message: 'Preview service unavailable' })
  }
})

it('preserves zero-used CI capacity when the runner inventory is empty', async () => {
  vi.stubGlobal('window', { location: { search: '?preview=resource-empty' } })
  const response = await fetch(`${origin}/v1/mock-org/ci/runners`)
  expect(await response.json()).toMatchObject({
    items: [],
    capacity: { available: true, used: 0, effective_limit: 3, commerce_limit: 5, max_concurrent_jobs: 3 },
  })
})

it('preserves CI limit metadata when connections are empty', async () => {
  vi.stubGlobal('window', { location: { search: '?preview=resource-empty' } })
  expect(await (await fetch(`${origin}/v1/mock-org/ci/settings`)).json()).toMatchObject({
    connections: [],
    available: true,
    effective_limit: 3,
    commerce_limit: 5,
    max_concurrent_jobs: 3,
  })
})

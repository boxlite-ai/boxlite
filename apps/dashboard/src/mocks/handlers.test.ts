/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const apiUrl = 'http://api.mock.test/api'
const server = setupServer()

beforeAll(async () => {
  vi.stubEnv('VITE_API_URL', apiUrl)
  const { handlers } = await import('./handlers')
  server.use(...handlers)
  server.listen({ onUnhandledRequest: 'error' })
})

afterAll(() => {
  server.close()
  vi.unstubAllEnvs()
})

describe('signed preview mock port validation', () => {
  it.each(['0', '65536', '3000.5', 'NaN', 'not-a-port'])('rejects port %s', async (port) => {
    const response = await fetch(`${apiUrl}/box/mock-box/ports/${port}/signed-preview-url`)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ statusCode: 400, message: 'Invalid port' })
  })

  it.each([1, 3000, 8080, 22222, 65535])('signs a preview for integer port %i', async (port) => {
    const response = await fetch(`${apiUrl}/box/mock-box/ports/${port}/signed-preview-url`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.boxId).toBe('mock-box')
    expect(body.port).toBe(port)
    expect(body.url).toBe(`https://${port}-${body.token}.proxy.mock.boxlite.ai?ttl=60`)
  })
})

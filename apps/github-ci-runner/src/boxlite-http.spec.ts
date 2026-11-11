/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BoxLiteHttp } from './boxlite-http'

describe('standalone BoxLite HTTP authority and bounded responses', () => {
  const original = global.fetch
  const principal = { sub: 'owner', principal_type: 'user', path_prefix: 'tenant' }
  beforeEach(() => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify(principal))) as typeof fetch
  })
  afterEach(() => {
    global.fetch = original
  })
  it.each([
    'http://external.test',
    'https://user:secret@box.test',
    'https://box.test?token=bad',
    'https://box.test#fragment',
    'https://box.test/foreign',
  ])('rejects unsafe configured origins %s before forwarding credentials', async (endpoint) => {
    await expect(BoxLiteHttp.connect(endpoint, 'private-key')).rejects.toThrow()
    expect(global.fetch).not.toHaveBeenCalled()
  })
  it.each(['http://localhost', 'http://127.0.0.1:3001', 'http://[::1]:3001'])(
    'supports explicit loopback development %s',
    async (endpoint) => {
      const client = await BoxLiteHttp.connect(endpoint, 'private-key')
      expect(client.root).toBe(endpoint + '/v1')
      expect(() => JSON.stringify(client)).toThrow('memory-only')
    },
  )
  it.each([
    null,
    {},
    { ...principal, sub: '' },
    { ...principal, principal_type: 'admin' },
    { ...principal, path_prefix: '../other' },
  ])('rejects invalid upstream principals %p', async (value) => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify(value))) as typeof fetch
    await expect(BoxLiteHttp.connect('https://box.test', 'private-key')).rejects.toThrow('Invalid BoxLite principal')
  })
  it.each(['outside', '//evil.test', '/box#fragment', '/box\\escape'])(
    'rejects unsafe request paths %s',
    async (path) => {
      const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
      jest.mocked(global.fetch).mockClear()
      await expect(client.request('GET', path)).rejects.toThrow('Invalid BoxLite route')
      expect(global.fetch).not.toHaveBeenCalled()
    },
  )
  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)(
    'classifies ambiguous %s replies without exposing their content',
    async (method) => {
      const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
      global.fetch = jest.fn(async () => new Response('private upstream content', { status: 503 })) as typeof fetch
      await expect(client.request(method, '/boxes', {}, AbortSignal.timeout(1000))).rejects.toMatchObject({
        message: 'BoxLite request failed',
        status: 503,
        uncertain: method !== 'GET',
      })
    },
  )
  it.each(['large', 'missing', 'upload-unacknowledged'])(
    'rejects invalid successful responses: %s',
    async (scenario) => {
      const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
      global.fetch = jest.fn(
        async () => new Response(scenario === 'missing' ? null : scenario === 'large' ? 'x'.repeat(4194305) : '{}'),
      ) as typeof fetch
      await expect(
        client.request(scenario === 'upload-unacknowledged' ? 'PUT' : 'GET', '/boxes'),
      ).rejects.toMatchObject({ status: 200, uncertain: scenario === 'upload-unacknowledged' })
    },
  )
})

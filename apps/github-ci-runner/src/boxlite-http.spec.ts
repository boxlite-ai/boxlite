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
  describe('boxlite-http timeout-ID recovery', () => {
    it.each([false, true])(
      'retains only the original ID from a complete chunked 408 body (progress=%s)',
      async (progress) => {
        const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
        const body = JSON.stringify({
          boxId: 'original-box',
          message: 'private upstream content',
          ...(progress ? { progress: { phase: 'pulling', secret: 'private progress' } } : {}),
        })
        global.fetch = jest.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(Buffer.from(body.slice(0, 16)))
                  controller.enqueue(Buffer.from(body.slice(16)))
                  controller.close()
                },
              }),
              { status: 408 },
            ),
        ) as typeof fetch
        const error = await client.request('POST', '/boxes', {}).catch((error: unknown) => error)
        expect(error).toMatchObject({ status: 408, uncertain: true, boxId: 'original-box' })
        expect(JSON.stringify(error)).not.toContain('private')
        expect(String(error)).toBe('Error: BoxLite request failed')
      },
    )
    it.each([
      ['missing', null],
      ['no ID', '{}'],
      ['malformed', '{"boxId":'],
      ['truncated', '{"boxId":"original-box"'],
      ['wrong type', '{"boxId":42}'],
      ['unsafe ID', '{"boxId":"../foreign"}'],
      ['empty ID', '{"boxId":""}'],
      ['long ID', JSON.stringify({ boxId: 'x'.repeat(129) })],
      ['oversized', JSON.stringify({ boxId: 'original-box', padding: 'x'.repeat(4194304) })],
      ['array', '[{"boxId":"original-box"}]'],
    ])('keeps an unusable timeout body uncertain: %s', async (_scenario, body) => {
      const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
      global.fetch = jest.fn(async () => new Response(body, { status: 408 })) as typeof fetch
      const error = await client.request('POST', '/boxes', {}).catch((error: unknown) => error)
      expect(error).toMatchObject({ status: 408, uncertain: true })
      expect(error).not.toHaveProperty('boxId', expect.any(String))
    })
    it('rejects a stream failure after an otherwise complete-looking ID', async () => {
      const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
      global.fetch = jest.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('{"boxId":"original-box"}'))
              },
              pull(controller) {
                controller.error(new Error('Private upstream stream failure'))
              },
            }),
            { status: 408 },
          ),
      ) as typeof fetch
      const error = await client.request('POST', '/boxes', {}).catch((error: unknown) => error)
      expect(error).toMatchObject({ status: 408, uncertain: true })
      expect(error).not.toHaveProperty('boxId', expect.any(String))
      expect(String(error)).not.toContain('Private')
    })
    it.each([
      ['GET', '/boxes', 408, true],
      ['POST', '/boxes/original-box/start', 408, true],
      ['POST', '/boxes', 503, true],
      ['POST', '/boxes', 408, false],
    ] as const)(
      'ignores IDs outside the scoped create timeout: %s %s %s scoped=%s',
      async (method, route, status, scoped) => {
        const client = await BoxLiteHttp.connect('https://box.test', 'private-key')
        global.fetch = jest.fn(async () => new Response('{"boxId":"foreign-box"}', { status })) as typeof fetch
        const error = await client.request(method, route, {}, undefined, scoped).catch((error: unknown) => error)
        expect(error).not.toHaveProperty('boxId', expect.any(String))
      },
    )
  })
})

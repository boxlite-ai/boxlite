/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { GitHubAppSource } from './github-app'
import { githubRequest, GitHubRequestError } from './github'

describe('CI App delivery client', () => {
  const original = global.fetch,
    keys = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    exactId = '3852017686796066816',
    guid = '0483df80-d7c0-11f1-8658-f0bd71afeb70',
    row = {
      id: 7,
      guid,
      delivered_at: '2026-11-03T12:34:56.123Z',
      status_code: 503,
      event: 'workflow_job',
      action: 'queued',
      installation_id: 9,
      repository_id: 11,
    },
    raw =
      '[{"id":3852017686796066816,"guid":"0483df80-d7c0-11f1-8658-f0bd71afeb70","delivered_at":"2026-11-03T12:34:56.123Z","status_code":503,"event":"workflow_job","action":"queued","installation_id":9,"repository_id":11}]',
    next = (cursor: string) =>
      `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=${encodeURIComponent(cursor)}>; rel="next"`
  let app: GitHubAppSource, fetcher: jest.Mock
  beforeEach(() => {
    app = new GitHubAppSource({ issuer: 'app-client', privateKey: () => keys.privateKey })
    fetcher = jest.fn(async () => new Response(raw))
    global.fetch = fetcher as typeof fetch
  })
  afterEach(() => {
    global.fetch = original
  })
  it('keeps the original large decimal identity across parsing and the POST route', async () => {
    const page = await app.deliveryPage()
    expect(page).toEqual({
      deliveries: [
        {
          id: exactId,
          guid,
          deliveredAt: Date.parse(row.delivered_at),
          statusCode: 503,
          event: 'workflow_job',
          action: 'queued',
          installationId: 9,
          repositoryId: 11,
        },
      ],
      cursor: null,
    })
    let committed = false
    fetcher.mockImplementationOnce(async (url, options) => {
      expect(committed).toBe(true)
      expect(String(url)).toBe(`https://api.github.com/app/hook/deliveries/${exactId}/attempts`)
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' })
      return new Response(null, { status: 202 })
    })
    await app.redeliver(page.deliveries[0].id, async () => {
      committed = true
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const jwt = ((fetcher.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization.slice(7),
      [header, payload, signature] = jwt.split('.')
    expect(
      verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true)
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe('app-client')
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.github.com/app/hook/deliveries?per_page=100')
  })
  it('uses opaque next cursors even on empty or short pages', async () => {
    const cursor = 'v1_abc+/=&?',
      headers = { link: next(cursor) }
    fetcher.mockImplementationOnce(async () => new Response('[]', { headers }))
    expect(await app.deliveryPage()).toEqual({ deliveries: [], cursor })
    fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify([row]), { headers: { link: next('later') } }),
    )
    const page = await app.deliveryPage(cursor)
    expect(page.deliveries[0].id).toBe('7')
    expect(page.cursor).toBe('later')
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('cursor')).toBe(cursor)
  })
  it('preserves nullable metadata instead of inventing an installation or HTTP result', async () => {
    fetcher.mockImplementation(
      async () =>
        new Response(
          JSON.stringify([{ ...row, status_code: null, installation_id: null, repository_id: null, action: null }]),
        ),
    )
    const page = await app.deliveryPage()
    expect(page.deliveries[0]).toMatchObject({
      statusCode: null,
      installationId: null,
      repositoryId: null,
      action: null,
    })
  })
  it.each([
    { id: 0 },
    { id: 1.5 },
    { id: '007' },
    { id: '1'.repeat(33) },
    { id: 1e40 },
    { guid: 'invalid' },
    { delivered_at: '2026-02-30T12:34:56Z' },
    { delivered_at: 'private-token' },
    { status_code: 600 },
    { status_code: 200.5 },
    { event: '../jobs' },
    { action: {} },
    { installation_id: 0 },
    { repository_id: '11' },
  ])('rejects invalid delivery metadata without publishing a partial page: %j', async (invalid) => {
    fetcher.mockImplementation(async () => new Response(JSON.stringify([row, { ...row, id: 8, ...invalid }])))
    await expect(app.deliveryPage()).rejects.toThrow()
  })
  it.each([[{}], [Array.from({ length: 101 }, (_, id) => ({ ...row, id: id + 1 }))], [[row, row]]])(
    'rejects malformed, oversized or duplicate-ID pages',
    async (value) => {
      fetcher.mockImplementation(async () => new Response(JSON.stringify(value)))
      await expect(app.deliveryPage()).rejects.toThrow()
    },
  )
  it.each([
    '<https://evil.test/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
    '<http://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
    '<https://user@api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
    '<https://api.github.com/user?per_page=100&cursor=next>; rel="next"',
    '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next#secret>; rel="next"',
    '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=a&cursor=b>; rel="next"',
    '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=a&status=failure>; rel="next"',
    '<https://api.github.com/app/hook/deliveries?per_page=30&cursor=a>; rel="next"',
    '<https://api.github.com/app/hook/deliveries?per_page=100>; rel="next"',
    'invalid next link',
    next('a') + ', ' + next('b'),
    next('x'.repeat(2049)),
  ])('rejects unsafe pagination and never follows its URL: %s', async (link) => {
    fetcher.mockImplementation(async () => new Response(raw, { headers: { link } }))
    await expect(app.deliveryPage()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.github.com/app/hook/deliveries?per_page=100')
  })
  it('rejects an immediate cursor loop and an oversized Link header', async () => {
    fetcher.mockImplementationOnce(async () => new Response(raw, { headers: { link: next('same') } }))
    await expect(app.deliveryPage('same')).rejects.toThrow('did not advance')
    fetcher.mockImplementationOnce(async () => new Response(raw, { headers: { link: 'x'.repeat(8193) } }))
    await expect(app.deliveryPage()).rejects.toBeInstanceOf(GitHubRequestError)
  })
  it.each(['', 'x'.repeat(2049), 'line\nnext'])(
    'rejects an invalid input cursor before signing or HTTP',
    async (cursor) => {
      await expect(app.deliveryPage(cursor)).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
  it.each(['../1', '0', '01', '1?x=2', '1'.repeat(33)])(
    'rejects invalid mutation IDs before the intent hook or HTTP: %s',
    async (id) => {
      const intent = jest.fn(async () => undefined)
      await expect(app.redeliver(id, intent)).rejects.toThrow()
      expect(intent).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
  it('requires a successful intent callback and honors cancellation before POST', async () => {
    await expect(app.redeliver(exactId, undefined as never)).rejects.toThrow('callback required')
    await expect(
      app.redeliver(exactId, async () => {
        throw new Error('Original lease denied')
      }),
    ).rejects.toThrow('lease denied')
    const stop = new AbortController()
    await expect(app.redeliver(exactId, async () => stop.abort(), stop.signal)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    const intent = jest.fn(async () => undefined)
    await expect(app.redeliver(exactId, intent, stop.signal)).rejects.toThrow()
    await expect(app.deliveryPage(undefined, stop.signal)).rejects.toThrow()
    expect(intent).not.toHaveBeenCalled()
  })
  it.each(['private-token', '"' + 'x'.repeat(1048576) + '"'])(
    'rejects malformed or oversized page JSON without exposing response content',
    async (body) => {
      fetcher.mockImplementation(async () => new Response(body))
      const error = await app.deliveryPage().catch((error) => error)
      expect(error).toBeInstanceOf(GitHubRequestError)
      expect(error).toMatchObject({ uncertain: false })
      expect(String(error)).not.toContain('private-token')
    },
  )
  it('refuses the page response mode for a mutation or device route', async () => {
    await expect(
      githubRequest({ url: 'https://api.github.com/app/hook/deliveries', method: 'POST', response: 'page' }),
    ).rejects.toMatchObject({ uncertain: false })
    await expect(
      githubRequest({ url: 'https://github.com/login/device/code', method: 'POST', response: 'page' }),
    ).rejects.toMatchObject({ uncertain: false })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps HTTP denial and retry metadata without exposing upstream text', async () => {
    fetcher.mockImplementation(
      async () => new Response('private-token', { status: 429, headers: { 'retry-after': '120' } }),
    )
    const error = await app.deliveryPage().catch((error) => error)
    expect(error).toMatchObject({ status: 429, uncertain: false })
    expect(error.retryAt).toBeGreaterThanOrEqual(Date.now() + 119000)
    expect(String(error)).not.toContain('private-token')
    fetcher.mockImplementation(async () => new Response('private-token', { status: 500 }))
    await expect(app.redeliver(exactId, async () => undefined)).rejects.toMatchObject({ status: 500, uncertain: true })
  })
})

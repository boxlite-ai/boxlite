import { CloudAppResources } from '../../cloud-app-resources'
import { DEFAULT_TIMING, type Ctx } from '../ctx'
import { SUPERVISOR_PROTOCOL } from '../platform'
import { Resources } from '../resources'
import { createServer } from '../server'
import { HttpSupervisorClient } from '../supervisor'

const volume = { name: 'uploads', mount: '/data/uploads', mode: 'rw' }
const volumes = '/v1/apps/example/envs/main/volumes'
const principal = {
  organizationId: 'org',
  userId: 'user',
  actor: 'user:user',
  permissions: ['read:apps', 'write:apps'],
}
const contents = Uint8Array.of(0x00, 0xff, 0x42)

function mountFixture(status = 'running', timing = { supervisorReadyMs: 1000, pollMs: 5 }) {
  const env = {
    id: 'env',
    name: 'main',
    active_box_id: 'box',
    box_url: 'https://box.example.test',
    live_deployment: 1,
    control_secret: 'supervisor-control',
  }
  const tokens = { stored: 'test-tunnel-token', active: 'test-tunnel-token' }
  const credentials = Object.assign(Object.create(CloudAppResources.prototype), {
    database: {
      query: async (sql: string, args: string[]) => {
        expect(sql).toContain('cloud_app.box_tunnels')
        expect(args).toEqual([env.box_url])
        return [{ encrypted_token: tokens.stored }]
      },
    },
    encryption: { decrypt: async (value: string) => value },
  }) as CloudAppResources
  const tunnelHeaders = jest.fn((boxUrl: string) => credentials.tunnelHeaders(boxUrl))
  const startBox = jest.fn(async () => {
    status = 'running'
  })
  const recordActivity = jest.fn(async () => undefined)
  const health = jest.fn((_request: Request) => Response.json({ version: SUPERVISOR_PROTOCOL }))
  const files = jest.fn(async (_request: Request) => Response.json({ entries: [] }))
  const upstream = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(status).toBe('running')
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe(env.box_url)
    if (request.headers.get('x-boxlite-access-token') !== tokens.active) {
      return Response.json(
        { code: 'TUNNEL_ACCESS_DENIED', message: 'private tunnel requires an API key, JWT, or access token' },
        { status: 401 },
      )
    }
    expect(request.headers.has('authorization')).toBe(false)
    expect(request.headers.has('x-boxlite-gateway')).toBe(false)
    if (request.headers.get('x-boxlite-control') !== env.control_secret) return new Response(null, { status: 403 })
    if (url.pathname === '/.boxlite/sv/health') return health(request)
    expect(url.pathname).toBe('/.boxlite/sv/files')
    return await files(request)
  })
  const ctx = {
    config: {},
    store: {
      appByName: async () => ({ id: 'app', name: 'example', org_id: 'org' }),
      envByName: async () => env,
      envById: async () => env,
      deployment: async () => ({ spec_version: 1 }),
      spec: async () => ({ volumes: [volume] }),
      recordActivity,
    },
    boxlite: { getBox: async () => ({ id: env.active_box_id, status }), startBox },
    supervisor: new HttpSupervisorClient(tunnelHeaders),
    tunnelHeaders,
    timing: { ...DEFAULT_TIMING, ...timing },
  } as unknown as Ctx
  ctx.resources = new Resources(ctx)
  const server = createServer(ctx)
  return {
    request: async (path: string, init?: RequestInit, caller = principal) =>
      await server.request(path, init, { platformPrincipal: caller }),
    env,
    files,
    health,
    recordActivity,
    startBox,
    tokens,
    tunnelHeaders,
    upstream,
  }
}

const filePath = (path: string) => `${volumes}/uploads/files?${new URLSearchParams({ path })}`

describe('App volume files through a private Box tunnel', () => {
  afterEach(() => jest.restoreAllMocks())

  it('lists declared volumes without contacting the Box', async () => {
    const { request, upstream } = mountFixture()
    expect(await (await request(volumes)).json()).toEqual([volume])
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each(['/', '/nested'])('lists %s through the private tunnel', async (path) => {
    const { request, env, files, health, tunnelHeaders } = mountFixture()
    const response = await request(filePath(path), { headers: { authorization: 'test-caller' } })
    expect(health).toHaveBeenCalledTimes(1)
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { volume: 'uploads', path, type: 'dir', entries: [] },
    })
    expect(new URL(files.mock.calls[0]![0].url).searchParams.get('path')).toBe(
      path === '/' ? '/data/uploads' : '/data/uploads/nested',
    )
    expect(tunnelHeaders.mock.calls).toEqual([[env.box_url], [env.box_url]])
  })

  it('wakes a stopped Box and streams a Console download before the source completes', async () => {
    const { request, files, startBox, env } = mountFixture('stopped')
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
        controller.enqueue(contents.slice(0, 1))
      },
    })
    files.mockResolvedValueOnce(
      new Response(stream, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(contents.byteLength) },
      }),
    )
    const response = await request('/v1/apps/example/volumes/uploads/files?path=/nested/data.bin')
    expect(startBox).toHaveBeenCalledWith(env.active_box_id)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="data.bin"')
    expect(response.headers.get('x-boxlite-file-size')).toBe(String(contents.byteLength))
    const reader = response.body!.getReader()
    expect(await reader.read()).toEqual({ value: contents.slice(0, 1), done: false })
    source!.enqueue(contents.slice(1))
    source!.close()
    expect(await reader.read()).toEqual({ value: contents.slice(1), done: false })
    expect((await reader.read()).done).toBe(true)
  })

  it('uploads binary data through the private tunnel', async () => {
    const { request, files, health } = mountFixture()
    files.mockResolvedValueOnce(Response.json({ bytes: contents.byteLength, replaced: false }))
    const response = await request(`${filePath('/temporary.bin')}&overwrite=1`, { method: 'PUT', body: contents })
    expect(health).toHaveBeenCalledTimes(1)
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { volume: 'uploads', path: '/temporary.bin', bytes: contents.byteLength, replaced: false },
    })
    const outgoing = files.mock.calls[0]![0]
    expect(outgoing.method).toBe('PUT')
    expect(outgoing.headers.get('content-type')).toBe('application/octet-stream')
    expect(new URL(outgoing.url).searchParams.get('overwrite')).toBe('1')
    expect(new Uint8Array(await outgoing.arrayBuffer())).toEqual(contents)
  })

  it('deletes a file from the Console and records the deletion', async () => {
    const { request, files, health, recordActivity } = mountFixture()
    files.mockResolvedValueOnce(Response.json({ removed: 'file' }))
    const response = await request('/v1/apps/example/volumes/uploads/files?path=/temporary.bin', { method: 'DELETE' })
    expect(health).toHaveBeenCalledTimes(1)
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { volume: 'uploads', path: '/temporary.bin', removed: 'file' },
    })
    expect(files.mock.calls[0]![0].method).toBe('DELETE')
    expect(recordActivity).toHaveBeenCalledWith('app', 'main', 'user:user', 'volume.delete', {
      volume: 'uploads',
      path: '/temporary.bin',
      removed: 'file',
    })
  })

  it.each([
    { upstreamError: Response.json({ error: 'no_such_file' }, { status: 404 }), status: 404, code: 'not_found' },
    { upstreamError: new Response('Not Found', { status: 404 }), status: 422, code: 'not_supported_yet' },
    {
      upstreamError: Response.json({ code: 'TUNNEL_ACCESS_DENIED', message: 'tunnel not found' }, { status: 404 }),
      status: 503,
      code: 'unavailable',
    },
  ])('maps an upstream HTTP 404 to HTTP $status and $code', async ({ upstreamError, status, code }) => {
    const { request, files } = mountFixture()
    files.mockResolvedValueOnce(upstreamError)
    const response = await request(filePath('/missing'))
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status,
      body: { error: { code } },
    })
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('does not follow a redirect from the authenticated file endpoint', async () => {
    const { request, files, upstream } = mountFixture()
    files.mockResolvedValueOnce(Response.redirect('https://redirect.example.test/', 307))
    const response = await request(filePath('/'))
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 503,
      body: { error: { code: 'unavailable', message: 'the Box answered 307' } },
    })
    expect(files.mock.calls[0]![0].redirect).toBe('manual')
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  it('does not start file I/O when the authenticated health endpoint redirects', async () => {
    const { request, files, health } = mountFixture()
    health.mockImplementation(() => Response.redirect('https://redirect.example.test/', 307))
    const response = await request(filePath('/'))
    expect(response.status).toBe(503)
    expect(health.mock.calls[0]![0].redirect).toBe('manual')
    expect(files).not.toHaveBeenCalled()
  })

  it('ends readiness polling at its deadline even when the poll interval is longer', async () => {
    jest.useFakeTimers()
    try {
      const { request, files, health } = mountFixture('running', { supervisorReadyMs: 50, pollMs: 500 })
      health.mockImplementation(() => new Response(null, { status: 503 }))
      let result: Response | undefined
      const pending = request(filePath('/')).then((response) => {
        result = response
      })
      await jest.advanceTimersByTimeAsync(50)
      expect(result?.status).toBe(503)
      expect(health).toHaveBeenCalledTimes(1)
      expect(files).not.toHaveBeenCalled()
      await pending
    } finally {
      await jest.runOnlyPendingTimersAsync()
      jest.useRealTimers()
    }
  })

  it('rejects a stale stored token once and succeeds after the record updates', async () => {
    const { request, files, health, tokens, upstream } = mountFixture()
    health.mockImplementationOnce(() => {
      tokens.active = 'replacement-token'
      return Response.json({ version: SUPERVISOR_PROTOCOL })
    })
    const rejected = await request(filePath('/temporary.bin'), { method: 'DELETE' })
    expect(rejected.status).toBe(503)
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(files).not.toHaveBeenCalled()

    tokens.stored = tokens.active
    files.mockResolvedValueOnce(Response.json({ removed: 'file' }))
    const accepted = await request(filePath('/temporary.bin'), { method: 'DELETE' })
    expect(accepted.status).toBe(200)
    expect(files).toHaveBeenCalledTimes(1)
  })

  it('does not send a file request if the lookup completes after its deadline', async () => {
    const { request, tunnelHeaders, health, upstream } = mountFixture()
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => realTimeout(ms === 60_000 ? 25 : ms))
    const credential = tunnelHeaders.getMockImplementation()!
    let finishLookup: (() => void) | undefined
    const lateLookup = new Promise<Awaited<ReturnType<typeof credential>>>((resolve) => {
      finishLookup = () => void resolve({ 'X-BoxLite-Access-Token': 'test-tunnel-token' })
    })
    tunnelHeaders.mockImplementationOnce(credential).mockReturnValueOnce(lateLookup)
    try {
      const response = await request(filePath('/'))
      expect(response.status).toBe(503)
      expect(health).toHaveBeenCalledTimes(1)
      expect(upstream).toHaveBeenCalledTimes(1)
    } finally {
      finishLookup?.()
    }
    await Promise.resolve()
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('rejects traversal and cross-organization requests before contacting the Box', async () => {
    const { request, upstream } = mountFixture()
    expect((await request(filePath('/../secret'))).status).toBe(403)
    expect((await request(filePath('/'), undefined, { ...principal, organizationId: 'other-org' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})

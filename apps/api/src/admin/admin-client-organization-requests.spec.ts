import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import axios, { AxiosInstance } from 'axios'
import { AdminApi, AdminApiAxiosParamCreator, AdminApiFactory, AdminApiFp, Configuration } from '@boxlite-ai/api-client'

// The generated TypeScript client is the consumer-side request layer for the
// Admin organization contract; this checks what it sends to a local server.
describe('generated AdminApi organization requests', () => {
  let server: Server
  let admin: AdminApi
  let configuration: Configuration
  let transport: AxiosInstance
  const requests: Array<{ method?: string; url?: string; headers?: Record<string, unknown> }> = []
  const timeouts: Array<number | undefined> = []
  const surfaces = ['class', 'factory', 'fp', 'request-creator'] as const

  // Exercise JavaScript positional calls independently of the TypeScript compatibility fixture.
  const invoke = async (surface: (typeof surfaces)[number], args: unknown[]) => {
    if (surface === 'class') return Reflect.apply(admin.adminListOrganizationsOverview, admin, args)
    if (surface === 'factory') {
      const factory = AdminApiFactory(configuration, undefined, transport)
      return Reflect.apply(factory.adminListOrganizationsOverview, factory, args)
    }
    if (surface === 'fp') {
      const fp = AdminApiFp(configuration)
      const request = await Reflect.apply(fp.adminListOrganizationsOverview, fp, args)
      return request(transport)
    }
    const creator = AdminApiAxiosParamCreator(configuration)
    const request = await Reflect.apply(creator.adminListOrganizationsOverview, creator, args)
    return transport.request({ ...request.options, baseURL: configuration.basePath, url: request.url })
  }

  const sent = () => {
    expect(requests).toHaveLength(1)
    const [{ method, url }] = requests.splice(0)
    const parsed = new URL(url ?? '', 'http://127.0.0.1')
    return { method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, headers: request.headers })
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    // A loopback request must not follow an http_proxy from the environment.
    configuration = new Configuration({ basePath: `http://127.0.0.1:${port}/api` })
    transport = axios.create({ proxy: false })
    transport.interceptors.request.use((request) => {
      timeouts.push(request.timeout)
      return request
    })
    admin = new AdminApi(configuration, undefined, transport)
  })

  afterEach(() => {
    requests.length = 0
    timeouts.length = 0
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it.each(surfaces)(
    '%s preserves legacy sixth-position request options without putting credentials in the URL',
    async (surface) => {
      await invoke(surface, [
        'legacy org',
        'next',
        20,
        '2026-10-20T00:00:00Z',
        '2026-10-19T00:00:00Z',
        { headers: { Authorization: 'Bearer synthetic-legacy-credential', 'X-Request-Test': 'legacy' }, timeout: 2345 },
      ])
      expect(requests[0]?.headers?.authorization).toBe('Bearer synthetic-legacy-credential')
      expect(requests[0]?.headers?.['x-request-test']).toBe('legacy')
      expect(timeouts).toEqual([2345])
      expect(requests[0]?.url).not.toContain('synthetic-legacy-credential')
      expect(sent()).toEqual({
        method: 'GET',
        path: '/api/admin/organizations',
        query: {
          q: 'legacy org',
          cursor: 'next',
          limit: '20',
          createdTo: '2026-10-20T00:00:00Z',
          createdFrom: '2026-10-19T00:00:00Z',
        },
      })
    },
  )

  it.each(surfaces.flatMap((surface) => ['all', undefined].map((scope) => [surface, scope] as const)))(
    '%s preserves extended request options with scope %s',
    async (surface, scope) => {
      const id = '00000000-0000-4000-8000-000000000011'
      await invoke(surface, [
        undefined,
        'next',
        20,
        undefined,
        undefined,
        scope,
        id,
        {
          headers: { Authorization: 'Bearer synthetic-extended-credential', 'X-Request-Test': 'extended' },
          timeout: 3456,
        },
      ])
      expect(requests[0]?.headers?.authorization).toBe('Bearer synthetic-extended-credential')
      expect(requests[0]?.headers?.['x-request-test']).toBe('extended')
      expect(timeouts).toEqual([3456])
      expect(requests[0]?.url).not.toContain('synthetic-extended-credential')
      expect(sent()).toEqual({
        method: 'GET',
        path: '/api/admin/organizations',
        query: { cursor: 'next', limit: '20', organizationId: id, ...(scope ? { boxCountScope: scope } : {}) },
      })
    },
  )

  it('sends the creation window only when the list sets it', async () => {
    await admin.adminListOrganizationsOverview()
    expect(sent()).toEqual({ method: 'GET', path: '/api/admin/organizations', query: {} })

    await admin.adminListOrganizationsOverview(
      undefined,
      undefined,
      undefined,
      '2026-10-20T00:00:00Z',
      '2026-10-19T00:00:00Z',
    )
    expect(sent()).toEqual({
      method: 'GET',
      path: '/api/admin/organizations',
      query: { createdFrom: '2026-10-19T00:00:00Z', createdTo: '2026-10-20T00:00:00Z' },
    })
  })

  it('sends include only when the detail selects optional sections', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000011'
    const path = `/api/admin/organizations/${organizationId}`

    await admin.adminGetOrganizationOverview(organizationId)
    expect(sent()).toEqual({ method: 'GET', path, query: {} })

    await admin.adminGetOrganizationOverview(organizationId, undefined, undefined, undefined, 'usage,activation')
    expect(sent()).toEqual({ method: 'GET', path, query: { include: 'usage,activation' } })
  })
  it('sends all-state inventory with registration windows and exact organization queries', async () => {
    await admin.adminListOrganizationsOverview(
      undefined,
      undefined,
      200,
      '2026-11-03T00:00:00Z',
      '2026-11-02T00:00:00Z',
      'all',
    )
    expect(sent()).toEqual({
      method: 'GET',
      path: '/api/admin/organizations',
      query: {
        boxCountScope: 'all',
        limit: '200',
        createdFrom: '2026-11-02T00:00:00Z',
        createdTo: '2026-11-03T00:00:00Z',
      },
    })
    const id = '00000000-0000-4000-8000-000000000011'
    await admin.adminListOrganizationsOverview(undefined, 'next', 20, undefined, undefined, 'all', id, {
      headers: { 'X-Request-Test': 'inventory' },
    })
    expect(requests[0]?.headers?.['x-request-test']).toBe('inventory')
    expect(sent()).toEqual({
      method: 'GET',
      path: '/api/admin/organizations',
      query: { boxCountScope: 'all', organizationId: id, cursor: 'next', limit: '20' },
    })
    await admin.adminListOrganizationsOverview()
    expect(sent()).toEqual({ method: 'GET', path: '/api/admin/organizations', query: {} })
  })
})

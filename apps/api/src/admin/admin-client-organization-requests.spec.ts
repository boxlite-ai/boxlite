import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import axios from 'axios'
import { AdminApi, Configuration } from '@boxlite-ai/api-client'

// The generated TypeScript client is the consumer-side request layer for the
// Admin organization contract; this checks what it sends to a local server.
describe('generated AdminApi organization requests', () => {
  let server: Server
  let admin: AdminApi
  const requests: Array<{ method?: string; url?: string }> = []

  const sent = () => {
    expect(requests).toHaveLength(1)
    const [{ method, url }] = requests.splice(0)
    const parsed = new URL(url ?? '', 'http://127.0.0.1')
    return { method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    // A loopback request must not follow an http_proxy from the environment.
    admin = new AdminApi(
      new Configuration({ basePath: `http://127.0.0.1:${port}/api` }),
      undefined,
      axios.create({ proxy: false }),
    )
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

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
})

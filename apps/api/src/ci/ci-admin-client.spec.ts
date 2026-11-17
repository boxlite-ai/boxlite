/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import axios from 'axios'
import { AdminApi, AdminLookupCiConnectionsAccountTypeEnum, Configuration } from '@boxlite-ai/api-client'

describe('Generated CI admin client HTTP requests', () => {
  let server: Server, client: AdminApi
  const org = '11111111-1111-4111-8111-111111111111',
    binding = '22222222-2222-4222-8222-222222222222'
  const requests: {
    method?: string
    path: string
    query: Record<string, string>
    authorization?: string
    body: unknown
  }[] = []
  const input = { account_type: 'User' as const, github_account: 'alice', allow_private_repositories: false }
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString(),
        url = new URL(request.url!, 'http://localhost')
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : undefined,
      })
      response.writeHead(request.method === 'DELETE' ? 204 : 200, { 'content-type': 'application/json' })
      response.end(request.method === 'DELETE' ? undefined : '{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    client = new AdminApi(
      new Configuration({ accessToken: 'fixture-admin-key' }),
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
      axios.create({ proxy: false }),
    )
  })
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  beforeEach(() => {
    requests.length = 0
  })
  it('serializes omitted, false and conditional replacement fields through production request code', async () => {
    await client.adminCreateCiConnection(org, input)
    await client.adminCreateCiConnection(org, { ...input, force: false })
    await client.adminCreateCiConnection(org, {
      ...input,
      force: true,
      expected_binding_id: binding,
      expected_generation: '9007199254740993',
    })
    expect(requests.map((request) => request.body)).toEqual([
      input,
      { ...input, force: false },
      { ...input, force: true, expected_binding_id: binding, expected_generation: '9007199254740993' },
    ])
    for (const request of requests)
      expect(request).toMatchObject({
        method: 'POST',
        path: `/api/admin/organizations/${org}/ci/connections`,
        authorization: 'Bearer fixture-admin-key',
        query: {},
      })
  })
  it('uses exact lookup filters and cursor pages, and preserves versioned PATCH/DELETE JSON bodies', async () => {
    await client.adminLookupCiConnections(AdminLookupCiConnectionsAccountTypeEnum.USER, undefined, undefined, 'Alice')
    await client.adminLookupCiConnections(AdminLookupCiConnectionsAccountTypeEnum.USER, binding, 100, undefined, '20')
    await client.adminListCiConnections(org, binding, 25)
    await client.adminUpdateCiConnection(org, binding, { expected_generation: '2', allow_private_repositories: false })
    await client.adminDeleteCiConnection(org, binding, { expected_generation: '3' })
    expect(
      requests.map((request) => ({
        method: request.method,
        path: request.path,
        query: request.query,
        body: request.body,
      })),
    ).toEqual([
      { method: 'GET', path: '/api/admin/ci/connections', query: { account_type: 'User', github_account: 'Alice' } },
      {
        method: 'GET',
        path: '/api/admin/ci/connections',
        query: { account_type: 'User', cursor: binding, limit: '100', github_account_id: '20' },
      },
      {
        method: 'GET',
        path: `/api/admin/organizations/${org}/ci/connections`,
        query: { cursor: binding, limit: '25' },
      },
      {
        method: 'PATCH',
        path: `/api/admin/organizations/${org}/ci/connections/${binding}`,
        query: {},
        body: { expected_generation: '2', allow_private_repositories: false },
      },
      {
        method: 'DELETE',
        path: `/api/admin/organizations/${org}/ci/connections/${binding}`,
        query: {},
        body: { expected_generation: '3' },
      },
    ])
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { ApiKeysApi, Configuration, CreateApiKeyProxyPermissionsEnum, OrganizationsApi } from '@boxlite-ai/api-client'

const grants: { label: string; proxyPermissions?: CreateApiKeyProxyPermissionsEnum[] }[] = [
  { label: 'omitted' },
  { label: 'granted', proxyPermissions: ['write:proxies'] },
  { label: 'cleared', proxyPermissions: [] },
]

describe('proxy permissions on SDK requests', () => {
  let server: Server
  let keys: ApiKeysApi
  let organizations: OrganizationsApi
  let received: unknown

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      received = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization,
        organization: request.headers['x-boxlite-organization-id'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const basePath = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    const configuration = new Configuration({ accessToken: 'test-token' })
    keys = new ApiKeysApi(configuration, basePath)
    organizations = new OrganizationsApi(configuration, basePath)
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })

  it.each(grants)('serializes the API key grant when $label', async ({ proxyPermissions }) => {
    const legacyBody = { name: 'key', permissions: ['write:boxes' as const] }
    const body = { ...legacyBody, ...(proxyPermissions === undefined ? {} : { proxyPermissions }) }

    await keys.createApiKey(body, 'test-org')

    expect(received).toEqual({
      method: 'POST',
      url: '/api/api-keys',
      contentType: 'application/json',
      authorization: 'Bearer test-token',
      organization: 'test-org',
      body,
    })
  })

  it.each(grants)('serializes role creation and update when $label', async ({ proxyPermissions }) => {
    const legacyBody = { name: 'maintainer', description: 'Operates boxes', permissions: ['write:boxes' as const] }
    const body = { ...legacyBody, ...(proxyPermissions === undefined ? {} : { proxyPermissions }) }
    const expected = { contentType: 'application/json', authorization: 'Bearer test-token', body }

    await organizations.createOrganizationRole('test-org', body)
    expect(received).toEqual({ ...expected, method: 'POST', url: '/api/organizations/test-org/roles' })

    await organizations.updateOrganizationRole('test-org', 'role-id', body)
    expect(received).toEqual({ ...expected, method: 'PUT', url: '/api/organizations/test-org/roles/role-id' })
  })
})

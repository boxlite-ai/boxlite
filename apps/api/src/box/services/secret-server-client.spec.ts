/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { createServer, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Logger } from '@nestjs/common'
import { GoogleAuth } from 'google-auth-library'
import { TypedConfigService } from '../../config/typed-config.service'
import { SecretServerClient } from './secret-server-client'

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const secrets = [
  { name: 'first', value: 'value-marker', hosts: ['first.example'], headers: { Authorization: 'Bearer {value}' } },
  {
    name: 'second',
    value: 'second-marker',
    hosts: ['second.example'],
    headers: { 'x-key': '{value}' },
    placeholder: 'dummy-marker',
  },
]

function client(url: string, overrides: Record<string, unknown> = {}) {
  const values = {
    'secretServer.enabled': true,
    'secretServer.url': url,
    'secretServer.devToken': 'dev-token',
    ...overrides,
  }
  return new SecretServerClient({ get: (key: string) => values[key] } as TypedConfigService)
}

describe('SecretServerClient HTTP boundary', () => {
  let server: Server
  let url: string
  let requests: { path: string; authorization: string; body: any }[]
  let respond: (response: ServerResponse, body: any) => void
  let successStatus: number
  let logs: jest.SpyInstance

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ path: request.url, authorization: request.headers.authorization, body })
      respond(response, body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    requests = []
    successStatus = 201
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    respond = (response, body) => {
      response.writeHead(successStatus, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          secrets: body.secrets
            .map(({ name }, i) => ({ name, secret_id: ids[i], value: 'ignored-upstream-marker' }))
            .reverse(),
        }),
      )
    }
  })

  afterEach(() => jest.restoreAllMocks())
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it.each([200, 201])('matches a reordered %s response without copying values', async (status) => {
    successStatus = status
    const result = await client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org-id', 'user-id', secrets)
    expect(requests).toEqual([
      {
        path: '/internal/v1/boxes/Ab12Cd34Ef56/secrets',
        authorization: 'Bearer dev-token',
        body: {
          org_id: 'org-id',
          created_by: 'user-id',
          secrets: secrets.map((s) => ({ ...s, placeholder: s.placeholder ?? `<BOXLITE_SECRET:${s.name}>` })),
        },
      },
    ])
    expect(result).toEqual(
      secrets.map(({ name, hosts, headers, placeholder }, i) => ({
        name,
        hosts,
        headers,
        placeholder: placeholder ?? `<BOXLITE_SECRET:${name}>`,
        secretId: ids[i],
      })),
    )
    expect(result.every((secret) => !Object.hasOwn(secret, 'value'))).toBe(true)
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(
      /value-marker|dummy-marker|Bearer \{value\}|ignored-upstream-marker|dev-token/,
    )
  })

  it('preserves disabled input exactly and skips empty batches', async () => {
    expect(await client(url, { 'secretServer.enabled': false }).storeBoxSecrets('id', 'org', undefined, secrets)).toBe(
      secrets,
    )
    expect(await client(url).storeBoxSecrets('id', 'org', undefined, [])).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it.each([401, 503, 307, 204])(
    'fails status %s without retrying, redirecting, or exposing upstream detail',
    async (status) => {
      respond = (response) => {
        response.writeHead(status, { location: `${url}/redirected` })
        response.end('value-marker dummy-marker dev-token')
      }
      const failure = await client(url)
        .storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)
        .catch((error) => error)
      expect(failure.getStatus()).toBe(503)
      expect(failure.getResponse()).toEqual({ code: 'secret_store_unavailable', message: 'Secret store unavailable' })
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/value-marker|dummy-marker|dev-token/)
    },
  )

  it.each([
    {},
    { secrets: [] },
    { secrets: [{ name: 'first', secret_id: ids[0] }] },
    {
      secrets: [
        { name: 'first', secret_id: ids[0] },
        { name: 'first', secret_id: ids[1] },
      ],
    },
    {
      secrets: [
        { name: 'first', secret_id: ids[0] },
        { name: 'other', secret_id: ids[1] },
      ],
    },
    {
      secrets: [
        { name: 'first', secret_id: ids[0] },
        { name: 'second', secret_id: ids[0] },
      ],
    },
    {
      secrets: [
        { name: 'first', secret_id: 'invalid' },
        { name: 'second', secret_id: ids[1] },
      ],
    },
    { secrets: [null, null] },
  ])('rejects incomplete or ambiguous success mapping %j', async (body) => {
    respond = (response) => response.end(JSON.stringify(body))
    await expect(client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)).rejects.toMatchObject({
      status: 503,
    })
  })

  it.each([
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
    ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
  ])('rejects the same UUID with different casing: %s and %s', async (firstId, secondId) => {
    respond = (response) =>
      response.end(
        JSON.stringify({
          secrets: [
            { name: 'first', secret_id: firstId },
            { name: 'second', secret_id: secondId },
          ],
        }),
      )
    await expect(client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)).rejects.toMatchObject({
      status: 503,
    })
  })

  it('accepts distinct UUIDs with uppercase spelling', async () => {
    const firstId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    respond = (response) =>
      response.end(
        JSON.stringify({
          secrets: [
            { name: 'first', secret_id: firstId },
            { name: 'second', secret_id: ids[1] },
          ],
        }),
      )
    const references = await client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)
    expect(references.map(({ secretId }) => secretId)).toEqual([firstId, ids[1]])
  })

  it('rejects malformed JSON', async () => {
    respond = (response) => response.end('value-marker')
    await expect(client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)).rejects.toMatchObject({
      status: 503,
    })
  })

  it('bounds a stalled response body', async () => {
    respond = (response) => {
      response.writeHead(201)
      response.write('{')
    }
    await expect(client(url).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)).rejects.toMatchObject({
      status: 503,
    })
    expect(requests).toHaveLength(1)
    server.closeAllConnections()
  }, 10000)

  it('uses an ID token for the base audience independently of the transfer path', async () => {
    const identity = jest.spyOn(GoogleAuth.prototype, 'getIdTokenClient').mockResolvedValue({
      getRequestHeaders: async () => new Headers({ authorization: 'Bearer google-token' }),
    } as any)
    await client(url, { 'secretServer.devToken': undefined }).storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)
    expect(identity).toHaveBeenCalledWith(url)
    expect(requests[0].authorization).toBe('Bearer google-token')
  })

  it('fails identity acquisition before POST', async () => {
    jest.spyOn(GoogleAuth.prototype, 'getIdTokenClient').mockRejectedValue(new Error('value-marker'))
    await expect(
      client(url, { 'secretServer.devToken': undefined }).storeBoxSecrets('id', 'org', 'user', secrets),
    ).rejects.toMatchObject({ status: 503 })
    await expect(client(url).storeBoxSecrets('id', 'org', undefined, secrets)).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(0)
  })

  it('times out identity acquisition and never posts after a late completion', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    let release: (value: any) => void
    jest.spyOn(GoogleAuth.prototype, 'getIdTokenClient').mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const fetchSpy = jest.spyOn(global, 'fetch')
    try {
      const pending = expect(
        client(url, { 'secretServer.devToken': undefined }).storeBoxSecrets('id', 'org', 'user', secrets),
      ).rejects.toMatchObject({ status: 503 })
      await jest.advanceTimersByTimeAsync(6000)
      await pending
      release({ getRequestHeaders: async () => new Headers({ authorization: 'Bearer late' }) })
      await new Promise(setImmediate)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('supports an explicit same-ID repeat against an idempotent fake', async () => {
    const service = client(url)
    const first = await service.storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)
    const second = await service.storeBoxSecrets('Ab12Cd34Ef56', 'org', 'user', secrets)
    expect(second).toEqual(first)
    expect(requests[1].body).toEqual(requests[0].body)
  })
})

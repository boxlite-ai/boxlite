/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { UnauthorizedException, type INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { BoxService } from '../box/services/box.service'
import { BoxState } from '../box/enums/box-state.enum'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { MCP_METADATA_PATH, McpAuthMetadata } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpController } from './mcp.controller'
import { McpMetadataController } from './mcp-metadata.controller'
import { McpServerFactory } from './mcp-server.factory'

const PROTOCOL = '2026-07-28'
const CALLER = { userId: 'user-1', email: 'user@example.com', role: 'user' }
const MEMBER_ORG = '11111111-1111-4111-8111-111111111111'
const FOREIGN_ORG = '22222222-2222-4222-8222-222222222222'
const RESOURCE = 'https://boxlite.test/api/mcp'
const ISSUER = 'https://issuer.test/'
const TOKEN = 'Bearer test-token'

describe('McpController', () => {
  let app: INestApplication
  let origin: string
  let baseUrl: string
  let exists: jest.Mock
  let findAllDeprecated: jest.Mock
  let incrementFailedAuth: jest.Mock

  beforeAll(async () => {
    exists = jest.fn((organizationId: string, userId: string) =>
      Promise.resolve(organizationId === MEMBER_ORG && userId === CALLER.userId),
    )
    findAllDeprecated = jest.fn().mockResolvedValue([{ id: 'box-1' }])
    incrementFailedAuth = jest.fn().mockResolvedValue(undefined)
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController, McpMetadataController],
      providers: [
        McpServerFactory,
        McpAuthMetadata,
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => (key === 'mcp.resourceUrl' ? RESOURCE : undefined) },
        },
        { provide: JwtStrategy, useValue: { issuer: ISSUER } },
        { provide: FailedAuthTrackerService, useValue: { incrementFailedAuth } },
        { provide: OrganizationUserService, useValue: { exists } },
        {
          provide: BoxService,
          useValue: {
            findAllDeprecated,
            toBoxDtos: jest.fn().mockResolvedValue([{ id: 'box-1', name: 'web', state: BoxState.STARTED, memory: 2 }]),
          },
        },
      ],
    })
      // This spec covers the MCP wiring, not token checks (mcp-auth.guard.spec.ts):
      // like the real guard, the stub refuses a request without a token with a 401
      // and otherwise hands the controller an authenticated caller.
      .overrideGuard(McpAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const request = context.switchToHttp().getRequest()
          if (!request.headers.authorization) {
            throw new UnauthorizedException()
          }
          request.user = CALLER
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api', { exclude: [MCP_METADATA_PATH] })
    await app.listen(0)
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
    baseUrl = `${origin}/api/mcp`
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    exists.mockClear()
    findAllDeprecated.mockClear()
    incrementFailedAuth.mockClear()
  })

  /** A 2026-07-28 request: the version and client identity travel in `_meta` and the mirrored headers. */
  function rpc(
    method: string,
    params: Record<string, unknown> = {},
    { version = PROTOCOL, headers = {} }: { version?: string; headers?: Record<string, string> } = {},
  ) {
    const name = typeof params.name === 'string' ? { 'mcp-name': params.name } : {}
    return fetch(baseUrl, {
      method: 'POST',
      headers: {
        authorization: TOKEN,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': method,
        ...name,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'spec', version: '0' },
          },
        },
      }),
    })
  }

  function callListBoxes(organizationId: string) {
    return rpc('tools/call', { name: 'list_boxes', arguments: { organization_id: organizationId } })
  }

  it('advertises only the 2026-07-28 revision through server/discover', async () => {
    const response = await rpc('server/discover')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.result.resultType).toBe('complete')
    expect(body.result.supportedVersions).toEqual([PROTOCOL])
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('boxlite')
  })

  it('lists list_boxes as a cacheable complete result', async () => {
    const body = await (await rpc('tools/list')).json()

    expect(body.result.resultType).toBe('complete')
    expect(typeof body.result.ttlMs).toBe('number')
    expect(typeof body.result.cacheScope).toBe('string')
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_boxes'])
    expect(body.result.tools[0].inputSchema.required).toEqual(['organization_id'])
    expect(body.result.tools[0].annotations.readOnlyHint).toBe(true)
  })

  it('returns the boxes of an organization the caller belongs to', async () => {
    const response = await callListBoxes(MEMBER_ORG)
    const body = await response.json()

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(body.result.isError).toBeFalsy()
    const boxes = JSON.parse(body.result.content[0].text)
    // memory_mib comes from the REST mapper, so the reply went through the same mapping as GET /v1/boxes.
    expect(boxes).toEqual([expect.objectContaining({ box_id: 'box-1', name: 'web', memory_mib: 2048 })])
    expect(findAllDeprecated).toHaveBeenCalledWith(MEMBER_ORG)
  })

  it('refuses an organization the caller is not in without reading its boxes', async () => {
    const body = await (await callListBoxes(FOREIGN_ORG)).json()

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Organization not found or not accessible')
    expect(exists).toHaveBeenCalledWith(FOREIGN_ORG, CALLER.userId)
    expect(findAllDeprecated).not.toHaveBeenCalled()
  })

  it('rejects an organization_id that is not a UUID before any lookup', async () => {
    const body = await (await callListBoxes('not-a-uuid')).json()

    expect(body.error ?? body.result.isError).toBeTruthy()
    expect(exists).not.toHaveBeenCalled()
  })

  it('rejects a legacy initialize handshake with the supported versions', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        authorization: TOKEN,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '0' } },
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32022)
    expect(body.error.data.supported).toEqual([PROTOCOL])
  })

  it('rejects a modern request naming an unsupported version', async () => {
    const response = await rpc('tools/list', {}, { version: '2025-11-25' })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32022)
    expect(body.error.data.supported).toEqual([PROTOCOL])
  })

  it('rejects a request whose Mcp-Method header disagrees with the body', async () => {
    const response = await rpc('tools/list', {}, { headers: { 'mcp-method': 'server/discover' } })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe(-32020)
  })

  it('refuses a request that carries an Origin header', async () => {
    const response = await rpc('tools/list', {}, { headers: { origin: 'https://evil.example' } })

    expect(response.status).toBe(403)
  })

  it('offers no GET stream', async () => {
    const response = await fetch(baseUrl, { headers: { authorization: TOKEN, accept: 'text/event-stream' } })

    expect(response.status).toBe(405)
  })

  it('answers a request without a token with a challenge naming the metadata', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const challenge = response.headers.get('www-authenticate')

    expect(response.status).toBe(401)
    expect(challenge).toMatch(/^Bearer error="invalid_token"/)
    expect(challenge).toContain('resource_metadata="https://boxlite.test/.well-known/oauth-protected-resource/api/mcp"')
    // The global filter's logic still answers, so the failed attempt is counted.
    expect(incrementFailedAuth).toHaveBeenCalledTimes(1)
  })

  it('serves the protected resource metadata outside the api prefix', async () => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource/api/mcp`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER] })
  })
})

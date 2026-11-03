/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Test } from '@nestjs/testing'
import { UnauthorizedException, type INestApplication } from '@nestjs/common'
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import type { AddressInfo } from 'net'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { BoxState } from '../box/enums/box-state.enum'
import { NetworkInfoResponseDto } from '../box/dto/network-info.dto'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { OrganizationService } from '../organization/services/organization.service'
import type { AuthContext } from '../common/interfaces/auth-context.interface'
import { MCP_METADATA_PATH, McpAuthMetadata } from './auth/mcp-auth-metadata'
import { McpAuthGuard } from './auth/mcp-auth.guard'
import { McpController } from './mcp.controller'
import { McpMetadataController } from './auth/mcp-metadata.controller'
import { McpServerFactory } from './mcp-server.factory'
import { VolumeTools } from './tools/volume/volume-tools'
import { ImageTools } from './tools/image/image-tools'
import { RegistryTools } from './tools/registry/registry-tools'
import { BoxTools } from './tools/box/box-tools'
import { McpToolAccess } from './tools/shared/mcp-tool-access'
import { McpToolAudit } from './tools/shared/mcp-tool-audit'
import { NetworkTools } from './tools/box/network-tools'
import { McpExecutionTools } from './tools/execution/execution-tools'
import { McpFileTools } from './tools/files/file-tools'
import { McpMetricsTools } from './tools/metrics/metrics-tools'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'

const PROTOCOL = '2026-07-28'
const LEGACY_PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25']
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
  let findMembership: jest.Mock
  let findAllDeprecated: jest.Mock
  let incrementFailedAuth: jest.Mock

  beforeAll(async () => {
    findMembership = jest.fn((organizationId: string, userId: string) =>
      Promise.resolve(
        organizationId === MEMBER_ORG && userId === CALLER.userId ? { role: 'member', assignedRoles: [] } : null,
      ),
    )
    findAllDeprecated = jest.fn().mockResolvedValue([{ id: 'box-1' }])
    incrementFailedAuth = jest.fn().mockResolvedValue(undefined)
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController, McpMetadataController],
      providers: [
        McpServerFactory,
        McpAuthMetadata,
        { provide: VolumeTools, useValue: { register: jest.fn() } },
        { provide: ImageTools, useValue: { register: jest.fn() } },
        { provide: RegistryTools, useValue: { register: jest.fn() } },
        BoxTools,
        McpToolAccess,
        { provide: McpToolAudit, useValue: {} },
        { provide: BoxStateWaiterService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: {} },
        { provide: NetworkTools, useValue: { register: jest.fn() } },
        { provide: McpExecutionTools, useValue: { register: jest.fn() } },
        { provide: McpFileTools, useValue: { register: jest.fn() } },
        { provide: McpMetricsTools, useValue: { register: jest.fn() } },
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => (key === 'mcp.resourceUrl' ? RESOURCE : undefined) },
        },
        { provide: JwtStrategy, useValue: { issuer: ISSUER } },
        { provide: FailedAuthTrackerService, useValue: { incrementFailedAuth } },
        { provide: OrganizationUserService, useValue: { findOne: findMembership } },
        { provide: OrganizationService, useValue: { findOne: jest.fn().mockResolvedValue({ id: MEMBER_ORG }) } },
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
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
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
    findMembership.mockClear()
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

  function legacyPost(
    version: string,
    method: string,
    params: Record<string, unknown> = {},
    { notification = false, authenticated = true } = {},
  ) {
    return fetch(baseUrl, {
      method: 'POST',
      headers: {
        ...(authenticated ? { authorization: TOKEN } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(method === 'initialize' ? {} : { 'mcp-protocol-version': version }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: 1 }), method, params }),
      signal: AbortSignal.timeout(5000),
    })
  }

  async function legacyReply(response: Awaited<ReturnType<typeof legacyPost>>) {
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('mcp-session-id')).toBeNull()
    // Inspect the SDK's request-scoped SSE reply without adapting its JSON-RPC payload.
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)]
    expect(frames).toHaveLength(1)
    const body = JSON.parse(frames[0][1])
    expect(body).toEqual(expect.objectContaining({ jsonrpc: '2.0', id: 1, result: expect.any(Object) }))
    return body.result
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
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_boxes',
      'get_box',
      'box_exists',
      'create_box',
      'delete_box',
      'start_box',
      'stop_box',
      'get_config',
    ])
    expect(body.result.tools[0].inputSchema.required).toEqual(['organization_id'])
    expect(body.result.tools[0].annotations.readOnlyHint).toBe(true)
    expect(body.result.tools[0].annotations.destructiveHint).toBe(false)
    expect(body.result.tools[0].outputSchema).toEqual(
      expect.objectContaining({
        type: 'array',
        items: expect.objectContaining({
          required: expect.arrayContaining(['box_id', 'status', 'cpus', 'memory_mib']),
        }),
      }),
    )
  })

  it('returns the boxes of an organization the caller belongs to', async () => {
    const response = await callListBoxes(MEMBER_ORG)
    const body = await response.json()

    expect(response.headers.get('content-type')).toContain('application/json')
    expect(body.result.isError).toBeFalsy()
    const boxes = JSON.parse(body.result.content[0].text)
    // memory_mib comes from the REST mapper, so the reply went through the same mapping as GET /v1/boxes.
    expect(boxes).toEqual([expect.objectContaining({ box_id: 'box-1', name: 'web', memory_mib: 2048 })])
    expect(body.result.structuredContent).toEqual(boxes)
    expect(findAllDeprecated).toHaveBeenCalledWith(MEMBER_ORG)
  })

  it('returns an empty structured array for an organization without boxes', async () => {
    findAllDeprecated.mockResolvedValueOnce([])
    const toBoxDtos = app.get(BoxService).toBoxDtos as jest.Mock
    toBoxDtos.mockResolvedValueOnce([])

    const body = await (await callListBoxes(MEMBER_ORG)).json()

    expect(body.result.isError).toBeFalsy()
    expect(body.result.structuredContent).toEqual([])
    expect(JSON.parse(body.result.content[0].text)).toEqual([])
    expect(findAllDeprecated).toHaveBeenCalledWith(MEMBER_ORG)
  })

  it('preserves optional network policy and a zero exit code in structured results', async () => {
    const network = NetworkInfoResponseDto.fromBox({
      inboundEnabled: false,
      outboundEnabled: true,
      outboundAllowNet: ['api.example.com'],
    })
    const toBoxDtos = app.get(BoxService).toBoxDtos as jest.Mock
    toBoxDtos.mockResolvedValueOnce([{ id: 'box-1', state: BoxState.STOPPED, exitCode: 0, network }])

    const body = await (await callListBoxes(MEMBER_ORG)).json()

    expect(body.result.isError).toBeFalsy()
    expect(body.result.structuredContent).toEqual([
      expect.objectContaining({ box_id: 'box-1', status: 'stopped', exit_code: 0, network }),
    ])
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
  })

  it('refuses an organization the caller is not in without reading its boxes', async () => {
    const body = await (await callListBoxes(FOREIGN_ORG)).json()

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toBe('Organization not found or not accessible')
    expect(body.result).not.toHaveProperty('structuredContent')
    expect(findMembership).toHaveBeenCalledWith(FOREIGN_ORG, CALLER.userId)
    expect(findAllDeprecated).not.toHaveBeenCalled()
  })

  it('rejects an organization_id that is not a UUID before any lookup', async () => {
    const body = await (await callListBoxes('not-a-uuid')).json()

    expect(body.error ?? body.result.isError).toBeTruthy()
    expect(findMembership).not.toHaveBeenCalled()
  })

  it('rejects unknown tool arguments before any lookup', async () => {
    const response = await rpc('tools/call', {
      name: 'list_boxes',
      arguments: { organization_id: MEMBER_ORG, unexpected: true },
    })
    const body = await response.json()

    expect(body.error ?? body.result.isError).toBeTruthy()
    expect(findMembership).not.toHaveBeenCalled()
    expect(findAllDeprecated).not.toHaveBeenCalled()
  })

  it('does not list boxes when cancelled during membership admission', async () => {
    let admit!: (membership: { role: string; assignedRoles: [] }) => void
    const membership = new Promise<{ role: string; assignedRoles: [] }>((resolve) => {
      admit = resolve
    })
    findMembership.mockReturnValueOnce(membership)
    const registrations = jest.spyOn(McpServer.prototype, 'registerTool')
    const server = app.get(McpServerFactory).create(CALLER as AuthContext)
    try {
      const registration = registrations.mock.calls.find(([name]) => name === 'list_boxes')
      if (!registration) throw new Error('list_boxes was not registered')
      const invoke = registration[2] as (
        args: Record<string, unknown>,
        context: ServerContext,
      ) => Promise<CallToolResult>
      const controller = new AbortController()
      const pending = invoke({ organization_id: MEMBER_ORG }, {
        mcpReq: { signal: controller.signal },
      } as ServerContext)
      expect(findMembership).toHaveBeenCalledWith(MEMBER_ORG, CALLER.userId)
      controller.abort()
      admit({ role: 'member', assignedRoles: [] })
      const result = await pending
      expect(findAllDeprecated).not.toHaveBeenCalled()
      expect(result.isError).toBe(true)
    } finally {
      registrations.mockRestore()
      await server.close()
    }
  })

  it.each(LEGACY_PROTOCOLS)('serves a stateless %s client through the authenticated tools', async (version) => {
    const initialized = await legacyReply(
      await legacyPost(version, 'initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'legacy-spec', version: '0' },
      }),
    )
    expect(initialized.protocolVersion).toBe(version)
    expect(initialized.serverInfo.name).toBe('boxlite')
    expect(initialized.capabilities.tools).toBeDefined()

    const notification = await legacyPost(version, 'notifications/initialized', {}, { notification: true })
    expect(notification.status).toBe(202)
    expect(notification.headers.get('mcp-session-id')).toBeNull()
    expect(await notification.text()).toBe('')

    const catalog = await legacyReply(await legacyPost(version, 'tools/list'))
    expect(catalog).not.toHaveProperty('resultType')
    expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(['get_config', 'list_boxes']),
    )
    const listBoxes = catalog.tools.find((tool: { name: string }) => tool.name === 'list_boxes')
    expect(listBoxes.inputSchema.required).toEqual(['organization_id'])
    expect(listBoxes.outputSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        required: ['result'],
        properties: {
          result: expect.objectContaining({
            type: 'array',
            items: expect.objectContaining({ required: expect.arrayContaining(['box_id', 'status', 'memory_mib']) }),
          }),
        },
      }),
    )

    const config = await legacyReply(await legacyPost(version, 'tools/call', { name: 'get_config', arguments: {} }))
    expect(config.isError).toBeFalsy()
    expect(config.structuredContent.capabilities).toEqual(
      expect.objectContaining({ snapshots_enabled: false, inbound_update_enabled: true }),
    )
    expect(JSON.parse(config.content[0].text)).toEqual(config.structuredContent)
    expect(findMembership).not.toHaveBeenCalled()

    const callBoxes = (organizationId: string, extra: Record<string, unknown> = {}) =>
      legacyPost(version, 'tools/call', {
        name: 'list_boxes',
        arguments: { organization_id: organizationId, ...extra },
      })
    const boxes = await legacyReply(await callBoxes(MEMBER_ORG))
    expect(boxes.isError).toBeFalsy()
    expect(boxes.structuredContent).toEqual({
      result: [expect.objectContaining({ box_id: 'box-1', name: 'web', memory_mib: 2048 })],
    })
    expect(JSON.parse(boxes.content[0].text)).toEqual(boxes.structuredContent.result)
    expect(findMembership).toHaveBeenCalledWith(MEMBER_ORG, CALLER.userId)
    expect(findAllDeprecated).toHaveBeenCalledWith(MEMBER_ORG)

    findAllDeprecated.mockResolvedValueOnce([])
    const toBoxDtos = app.get(BoxService).toBoxDtos as jest.Mock
    toBoxDtos.mockResolvedValueOnce([])
    const empty = await legacyReply(await callBoxes(MEMBER_ORG))
    expect(empty.isError).toBeFalsy()
    expect(empty.structuredContent).toEqual({ result: [] })
    expect(JSON.parse(empty.content[0].text)).toEqual([])

    findAllDeprecated.mockClear()
    const denied = await legacyReply(await callBoxes(FOREIGN_ORG))
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toBe('Organization not found or not accessible')
    expect(denied).not.toHaveProperty('structuredContent')
    expect(findMembership).toHaveBeenLastCalledWith(FOREIGN_ORG, CALLER.userId)
    expect(findAllDeprecated).not.toHaveBeenCalled()

    findMembership.mockClear()
    const invalid = await legacyReply(await callBoxes('not-a-uuid'))
    const unknown = await legacyReply(await callBoxes(MEMBER_ORG, { unexpected: true }))
    expect(invalid.isError).toBe(true)
    expect(unknown.isError).toBe(true)
    expect(findMembership).not.toHaveBeenCalled()
    expect(findAllDeprecated).not.toHaveBeenCalled()

    const unauthenticated = await legacyPost(version, 'tools/list', {}, { authenticated: false })
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('www-authenticate')).toContain('resource_metadata=')
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

  it.each(['GET', 'DELETE'])('offers no %s stream or session operation', async (method) => {
    const response = await fetch(baseUrl, { method, headers: { authorization: TOKEN, accept: 'text/event-stream' } })

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

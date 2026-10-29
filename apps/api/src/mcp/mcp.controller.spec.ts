/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { Test } from '@nestjs/testing'
import { ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { BoxService } from '../box/services/box.service'
import { BoxState } from '../box/enums/box-state.enum'
import { TypedConfigService } from '../config/typed-config.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { McpRateLimitGuard } from './mcp-rate-limit.guard'
import { CustomHeaders } from '../common/constants/header.constants'
import { McpAuthorizationService } from './mcp-authorization.service'
import { McpController } from './mcp.controller'
import { McpServerFactory } from './mcp-server.factory'
import { McpAuthMetadata, MCP_METADATA_PATH } from './mcp-auth-metadata'
import { McpMetadataController } from './mcp-metadata.controller'
import { McpOperationsService } from './mcp-operations.service'

const PROTOCOL = '2026-07-28'
const ORG = '11111111-1111-4111-8111-111111111111'
const CALLER = { userId: 'user-1', organizationId: ORG, scopes: ['boxes:read'] }

describe('McpController', () => {
  let app: INestApplication
  let baseUrl: string
  const authorize = jest.fn()
  const findAll = jest.fn()
  const findOneByIdOrName = jest.fn()
  const admit = jest.fn()
  const dto = { id: 'box-1', name: 'web', state: BoxState.STARTED, memory: 2 }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController, McpMetadataController],
      providers: [
        McpServerFactory,
        McpAuthMetadata,
        { provide: McpOperationsService, useValue: { admit } },
        {
          provide: McpAuthorizationService,
          useValue: {
            authorize,
            authenticate: async (token: string) => {
              if (token !== 'test-key') throw new UnauthorizedException()
              return CALLER
            },
          },
        },
        {
          provide: TypedConfigService,
          useValue: {
            get: (key: string) =>
              (
                ({
                  'mcp.resourceUrl': 'https://boxlite.test/api/mcp',
                  'mcp.oauthEnabled': true,
                }) as Record<string, unknown>
              )[key],
          },
        },
        { provide: JwtStrategy, useValue: { issuer: 'https://issuer.test/' } },
        { provide: FailedAuthTrackerService, useValue: { incrementFailedAuth: jest.fn() } },
        {
          provide: BoxService,
          useValue: {
            findAll,
            findOneByIdOrName,
            toBoxDtos: jest.fn().mockResolvedValue([dto]),
            toBoxDtoWithExitCode: jest.fn().mockResolvedValue(dto),
          },
        },
      ],
    })
      .overrideGuard(McpRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api', { exclude: [MCP_METADATA_PATH] })
    await app.listen(0)
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    CALLER.scopes = ['boxes:read']
    admit.mockReset().mockResolvedValue({ operation_id: 'operation', state: 'queued' })
    authorize.mockReset().mockResolvedValue(CALLER)
    findAll.mockReset().mockResolvedValue({ items: [dto], totalPages: 2 })
    findOneByIdOrName.mockReset().mockResolvedValue(dto)
  })

  function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer test-key',
        'mcp-protocol-version': PROTOCOL,
        'mcp-method': method,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'spec', version: '0' },
          },
        },
      }),
    })
  }

  it('advertises modern discovery and strictly scoped read tools', async () => {
    const discovery = await (await rpc('server/discover')).json()
    expect(discovery.result.supportedVersions).toContain(PROTOCOL)
    const body = await (await rpc('tools/list')).json()
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_boxes', 'get_box'])
    expect(body.result.tools[0].inputSchema.additionalProperties).toBe(false)
  })
  it('returns a bounded page as structured content and JSON text', async () => {
    const body = await (await rpc('tools/call', { name: 'list_boxes', arguments: {} })).json()
    expect(body.result.isError).toBeFalsy()
    expect(body.result.structuredContent).toEqual({
      boxes: [expect.objectContaining({ box_id: 'box-1', memory_mib: 2048 })],
      page: 1,
      next_page: 2,
    })
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
    expect(findAll).toHaveBeenCalledWith(ORG, 1, 10)
  })
  it.each([{ organization_id: ORG }, { extra: true }, { page_size: 101 }])(
    'rejects invalid list arguments %p before lookup',
    async (args) => {
      const body = await (await rpc('tools/call', { name: 'list_boxes', arguments: args })).json()
      expect(body.error ?? body.result.isError).toBeTruthy()
      expect(findAll).not.toHaveBeenCalled()
    },
  )
  it('reauthorizes tool calls and redacts service error details', async () => {
    authorize.mockRejectedValue(new ForbiddenException('private detail'))
    const body = await (await rpc('tools/call', { name: 'list_boxes', arguments: {} })).json()
    expect(body.result.structuredContent).toEqual({ error: { code: 'permission_denied' } })
    expect(findAll).not.toHaveBeenCalled()
    expect(JSON.stringify(body)).not.toContain('private detail')
  })
  it('requires an explicit Box ID rather than resolving a name alias', async () => {
    const body = await (await rpc('tools/call', { name: 'get_box', arguments: { box_id: 'web' } })).json()
    expect(body.result.structuredContent).toEqual({ error: { code: 'not_found' } })
    expect(findOneByIdOrName).toHaveBeenCalledWith('web', ORG)
  })
  it('serves 2025-11-25 initialize and tool calls without a persistent session', async () => {
    async function legacy(method: string, params: unknown) {
      const response = await fetch(`${baseUrl}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-key',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('mcp-session-id')).toBeNull()
      const body = await response.text()
      return JSON.parse(
        body.startsWith('event:')
          ? body
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6)
          : body,
      )
    }
    expect(
      (
        await legacy('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'spec', version: '0' },
        })
      ).result.protocolVersion,
    ).toBe('2025-11-25')
    expect((await legacy('tools/call', { name: 'list_boxes', arguments: {} })).result.structuredContent.page).toBe(1)
  })
  it('rejects subscriptions without opening an event stream', async () => {
    const response = await rpc('subscriptions/listen', { notifications: {} })
    const contentType = response.headers.get('content-type')
    if (contentType?.includes('text/event-stream')) await response.body?.cancel()
    expect(contentType).toContain('application/json')
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Subscriptions are not supported' },
    })
  })
  it('rejects mismatched headers, browser Origins, and organization overrides', async () => {
    expect((await rpc('tools/list', {}, { 'mcp-method': 'server/discover' })).status).toBe(400)
    expect((await rpc('tools/list', {}, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await rpc('tools/list', {}, { [CustomHeaders.ORGANIZATION_ID.name]: ORG })).status).toBe(401)
  })
  it('returns discovery on 401 and offers no GET stream', async () => {
    const rejected = await rpc('tools/list', {}, { authorization: '' })
    expect(rejected.status).toBe(401)
    expect(rejected.headers.get('www-authenticate')).toContain(
      'https://boxlite.test/.well-known/oauth-protected-resource/api/mcp',
    )
    expect((await fetch(`${baseUrl}/api/mcp`, { headers: { authorization: 'Bearer test-key' } })).status).toBe(405)
    const metadata = await (await fetch(`${baseUrl}/${MCP_METADATA_PATH}`)).json()
    expect(metadata.resource).toBe('https://boxlite.test/api/mcp')
  })

  it('discovers all nine tools only for an authorized credential and forwards validated exec defaults', async () => {
    CALLER.scopes = ['boxes:read', 'boxes:write', 'boxes:delete']
    const discovery = await (await rpc('tools/list')).json()
    expect(discovery.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_boxes',
      'get_box',
      'create_box',
      'exec_box',
      'get_execution',
      'get_operation',
      'cancel_execution',
      'stop_box',
      'delete_box',
    ])
    const requestId = '33333333-3333-4333-8333-333333333333'
    const body = await (
      await rpc('tools/call', {
        name: 'exec_box',
        arguments: { box_id: 'box-1', command: 'echo', args: ['hello; literal'], request_id: requestId },
      })
    ).json()
    expect(body.result.isError).toBeFalsy()
    expect(admit).toHaveBeenCalledWith(
      CALLER,
      'exec_box',
      {
        box_id: 'box-1',
        command: 'echo',
        args: ['hello; literal'],
        request_id: requestId,
        timeout_seconds: 60,
        wait_seconds: 0,
      },
      expect.any(AbortSignal),
    )
    const invalid = await (
      await rpc('tools/call', {
        name: 'exec_box',
        arguments: { box_id: 'box-1', command: 'echo', request_id: requestId, env: { SECRET: 'value' } },
      })
    ).json()
    expect(invalid.error ?? invalid.result.isError).toBeTruthy()
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('bounds the complete wire result, including its duplicate JSON text', async () => {
    CALLER.scopes = ['boxes:write']
    admit.mockResolvedValue({ output: 'x'.repeat(16000) })
    const response = await rpc('tools/call', {
      name: 'exec_box',
      arguments: { box_id: 'box-1', command: 'echo', request_id: '33333333-3333-4333-8333-333333333333' },
    })
    const text = await response.text()
    expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024)
    expect(JSON.parse(text).result.structuredContent).toEqual({ error: { code: 'result_too_large' } })
    const discovery = await (await rpc('tools/list')).json()
    expect(discovery.result.tools.some((tool: { name: string }) => tool.name === 'list_boxes')).toBe(false)
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  CanActivate,
  Controller,
  Delete,
  Get,
  INestApplication,
  Injectable,
  Param,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import { MCP_STRATEGY } from '@rekog/mcp-nest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { McpDelegation } from '../auth/mcp-delegation'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { TypedConfigService } from '../config/typed-config.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter'
import { McpAuthMetadata } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpController, mcpStrategy } from './mcp.controller'
import { McpDispatcher } from './mcp-dispatcher'
import { setMcpOAuthScopes } from './mcp-oauth-policy'
import { servedOperations } from './mcp-routes'
import { McpTools } from './mcp-tools'

const CALLER = { userId: 'user-1', role: 'user', email: 'u@example.test', organizationId: 'org-1' }

/**
 * Admits `Bearer good` as {@link CALLER}, an API-key caller, and `Bearer oauth:<scopes>`
 * as an OAuth caller granted those comma-separated scopes, standing in for the
 * API-key and audience checks.
 */
@Injectable()
class FakeMcpAuthGuard implements CanActivate {
  canActivate(context: Parameters<CanActivate['canActivate']>[0]) {
    const req = context.switchToHttp().getRequest()
    if (!req.headers.authorization) throw new UnauthorizedException()
    const oauth = /^Bearer oauth:(.*)$/.exec(req.headers.authorization ?? '')
    if (req.headers.authorization !== 'Bearer good' && !oauth) return false
    req.user = CALLER
    if (oauth) setMcpOAuthScopes(req, oauth[1] ? oauth[1].split(',') : [])
    return true
  }
}

/** The REST route `getBox` reaches, behind the real `CombinedAuthGuard`. */
@Controller('v1/boxes')
@UseGuards(CombinedAuthGuard)
class BoxRoute {
  @Get(':boxId')
  getBox(@Param('boxId') boxId: string, @AuthContext() caller: unknown) {
    return { id: boxId, caller }
  }

  @Delete(':boxId')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  removeBox(@Param('boxId') boxId: string) {
    return { removed: boxId }
  }
}

const spec = (name: string) => parse(readFileSync(resolve(__dirname, '../../../../openapi', name), 'utf8'))

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: [McpController, BoxRoute],
    providers: [
      { provide: MCP_STRATEGY, useValue: mcpStrategy },
      McpTools,
      McpDispatcher,
      McpDelegation,
      { provide: McpAuthMetadata, useValue: { url: undefined } },
      { provide: FailedAuthTrackerService, useValue: { recordFailure: async () => undefined } },
      { provide: TypedConfigService, useValue: { get: () => 3000 } },
      McpAuthChallengeFilter,
    ],
  })
    .overrideGuard(McpAuthGuard)
    .useClass(FakeMcpAuthGuard)
    .compile()
  const app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()
  app.get(McpTools).register({
    box: spec('box.openapi.yaml'),
    admin: spec('admin.openapi.yaml'),
    dashboard: {},
    served: () => true,
  })
  await app.connectMicroservice({ strategy: mcpStrategy }).listen()
  return app
}

async function rpc(app: INestApplication, body: object, headers: Record<string, string> = {}) {
  const server = app.getHttpServer()
  const { port } = server.address() ?? (await new Promise((r) => server.listen(0, () => r(server.address()))))
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer good',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

describe('/api/mcp', () => {
  let app: INestApplication
  beforeAll(async () => {
    app = await boot()
  })
  afterAll(async () => {
    await app.close()
  })

  it('serves a 2025 client: initialize, then tools/list', async () => {
    const init = await rpc(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    expect(init.status).toBe(200)
    expect(init.json.result.serverInfo.name).toBe('boxlite')

    const list = await rpc(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-protocol-version': '2025-06-18' },
    )
    expect(list.json.result.tools).toHaveLength(13)
  })

  it('serves a 2026-07-28 client without a handshake', async () => {
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_CAPABILITIES_META_KEY]: {},
    }
    const list = await rpc(
      app,
      { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: meta } },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
    )

    expect(list.status).toBe(200)
    expect(list.json.result.tools).toHaveLength(13)
  })

  it('runs a tool call through the REST route as the MCP caller', async () => {
    const call = await rpc(
      app,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getBox', arguments: { box_id: 'my-box' } } },
      { 'mcp-protocol-version': '2025-06-18' },
    )

    expect(call.json.result.isError).toBe(false)
    expect(call.json.result.structuredContent).toEqual({ id: 'my-box', caller: CALLER })
  })

  it('refuses subscriptions/listen with one JSON error', async () => {
    const listen = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'subscriptions/listen', params: {} })

    expect(listen.status).toBe(400)
    expect(listen.json.error.code).toBe(-32601)
  })

  it('refuses a caller the MCP guard rejects', async () => {
    const denied = await rpc(app, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { authorization: 'Bearer bad' })

    expect(denied.status).toBe(403)
  })

  const call = (name: string, args: object, authorization: string) =>
    rpc(
      app,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
      { 'mcp-protocol-version': '2025-06-18', authorization },
    )

  it('challenges an OAuth caller missing a route permission with granted plus missing scopes', async () => {
    const server = app.getHttpServer()
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer oauth:write:boxes',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'removeBox', arguments: { box_id: 'my-box' } },
      }),
    })

    expect(response.status).toBe(403)
    const challenge = response.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('insufficient_scope')
    expect(challenge).toContain('scope="write:boxes delete:boxes"')
  })

  it('runs the same call once the OAuth caller holds the scope', async () => {
    const ok = await call('removeBox', { box_id: 'my-box' }, 'Bearer oauth:write:boxes,delete:boxes')

    expect(ok.status).toBe(200)
    expect(ok.json.result.structuredContent).toEqual({ removed: 'my-box' })
  })

  it('applies the step-up check to invoke_api_endpoint too', async () => {
    const denied = await call(
      'invoke_api_endpoint',
      { operationId: 'removeBox', arguments: { box_id: 'b' } },
      'Bearer oauth:',
    )

    expect(denied.status).toBe(403)
  })

  it.each(['configureSsh', 'createRegistry', 'createInvite', 'prepareTunnel'])(
    'refuses %s to an OAuth caller whatever its scopes',
    async (operationId) => {
      const denied = await call('invoke_api_endpoint', { operationId, arguments: {} }, 'Bearer oauth:write:boxes')

      expect(denied.status).toBe(403)
    },
  )

  it('leaves operations off the OAuth allowlist to API-key callers', async () => {
    const allowed = await call('invoke_api_endpoint', { operationId: 'configureSsh', arguments: {} }, 'Bearer good')

    expect(allowed.status).toBe(200)
  })

  it('names no scope in the 401 challenge, so clients request scopes_supported', async () => {
    const { port } = app.getHttpServer().address()
    const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).not.toContain('scope=')
  })

  it('reads served routes from the Nest app under its global prefix', () => {
    const served = servedOperations(app.getHttpAdapter().getInstance(), () => false)

    expect(served({ method: 'get', path: '/api/v1/boxes/{box_id}', webSocket: false })).toBe(true)
    expect(served({ method: 'post', path: '/api/mcp', webSocket: false })).toBe(true)
    expect(served({ method: 'get', path: '/api/v1/boxes', webSocket: false })).toBe(false)
  })
})

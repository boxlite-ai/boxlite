/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  All,
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  INestApplication,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestModule,
  Param,
  Post,
  Put,
  Req,
  RequestMethod,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import { MCP_STRATEGY } from '@rekog/mcp-nest'
import { ApiOperation, DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import type { Request } from 'express'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { parse } from 'yaml'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { McpDelegation } from '../auth/mcp-delegation'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { BoxliteWsProxyService } from '../boxlite-rest/boxlite-ws-proxy.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { McpAuthChallengeFilter } from './mcp-auth-challenge.filter'
import { MCP_ROOT_ROUTES, McpAuthMetadata } from './mcp-auth-metadata'
import { McpAuthGuard } from './mcp-auth.guard'
import { McpController, mcpStrategy } from './mcp.controller'
import { MCP_JSON_LIMIT_BYTES, useApiBodyParsers } from './mcp-body'
import { McpDispatcher } from './mcp-dispatcher'
import { McpMetadataController } from './mcp-metadata.controller'
import { setMcpOAuthScopes } from './mcp-oauth-policy'
import { servedOperations } from './mcp-routes'
import { McpTools } from './mcp-tools'

// `McpDispatcher` routes attach upgrades through `BoxliteWsProxyService`, whose
// proxy dependency ships ESM that Jest does not transform.
jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(() => ({ upgrade: jest.fn() })) }))

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

  /** Like the real exec proxy: an `@All` route that declares its permission. */
  @All(':boxId/exec')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  startExecution() {
    return { execution_id: 'exec-1' }
  }

  @Post(':boxId/ssh')
  configureSsh(@Param('boxId') boxId: string) {
    return { ssh: boxId }
  }

  /** Counts the tar bytes that reached the route. */
  @Put(':boxId/files')
  async uploadFiles(@Req() req: Request) {
    let bytes = 0
    for await (const chunk of req) bytes += (chunk as Buffer).length
    return { bytes }
  }
}

/** A non-MCP route that reads a JSON body, parsed by the default parsers. */
@Controller('echo')
class EchoRoute {
  @Post()
  echo(@Body() body: unknown) {
    return { echoed: body }
  }
}

@Controller('box')
@UseGuards(CombinedAuthGuard)
class AttachTicketRoute {
  @Post(':boxIdOrName/attach-tickets')
  @ApiOperation({ operationId: 'createAttachTicket' })
  createAttachTicket(@Param('boxIdOrName') boxIdOrName: string) {
    return { ticket: `ticket-for-${boxIdOrName}` }
  }
}

/** Stands in for the attach proxy: answers an upgrade with stdout `2` and exit 0. */
const attachSockets = new WebSocketServer({ noServer: true })
const wsProxy = {
  matchAttachPath: (url?: string) => (url?.includes('/attach?') ? {} : null),
  upgrade: async (req: never, socket: never, head: never) =>
    attachSockets.handleUpgrade(req, socket, head, (ws) => {
      ws.send(Buffer.from([0x01, ...Buffer.from('2\n')]))
      ws.send(JSON.stringify({ type: 'exit', exit_code: 0 }))
    }),
}

/**
 * Marks every response, applied the way `AppModule` applies its global middleware
 * (`{*path}`), so a test can see whether those middleware reach the MCP routes.
 */
@Module({})
class GlobalMiddlewareProbe implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
        res.setHeader('x-global-middleware', 'ran')
        next()
      })
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL })
  }
}

const spec = (name: string) => parse(readFileSync(resolve(__dirname, '../../../../openapi', name), 'utf8'))

/** Counts the failed-auth hits the 401 path records. */
const failedAuth = { recordFailure: async () => undefined, incrementFailedAuth: jest.fn(async () => undefined) }

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule, GlobalMiddlewareProbe],
    controllers: [McpController, McpMetadataController, BoxRoute, AttachTicketRoute, EchoRoute],
    providers: [
      { provide: MCP_STRATEGY, useValue: mcpStrategy },
      McpTools,
      McpDispatcher,
      McpDelegation,
      { provide: McpAuthMetadata, useValue: { url: undefined, document: () => ({ resource: 'metadata' }) } },
      { provide: FailedAuthTrackerService, useValue: failedAuth },
      { provide: BoxliteWsProxyService, useValue: wsProxy },
      McpAuthChallengeFilter,
    ],
  })
    .overrideGuard(McpAuthGuard)
    .useClass(FakeMcpAuthGuard)
    .compile()
  const app = moduleRef.createNestApplication({ bodyParser: false })
  app.setGlobalPrefix('api', { exclude: MCP_ROOT_ROUTES })
  useApiBodyParsers(app)
  await app.init()
  app.get(McpTools).register({
    box: spec('box.openapi.yaml'),
    admin: spec('admin.openapi.yaml'),
    dashboard: SwaggerModule.createDocument(app, new DocumentBuilder().build()),
    served: () => true,
  })
  await app.connectMicroservice({ strategy: mcpStrategy }).listen()
  return app
}

async function rpc(app: INestApplication, body: object, headers: Record<string, string> = {}) {
  const server = app.getHttpServer()
  const { port } = server.address() ?? (await new Promise((r) => server.listen(0, () => r(server.address()))))
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
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

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
/** The hints hosts use to decide which box tools need approval (design #2427). */
const BOX_TOOL_HINTS = {
  listBoxes: { ...read, openWorldHint: false },
  getBox: { ...read, openWorldHint: false },
  getExecution: { ...read, openWorldHint: false },
  downloadFiles: { ...read, openWorldHint: true },
  createBox: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  startBox: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  stopBox: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  removeBox: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  startExecution: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  uploadFiles: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}

function expectBoxToolHints(tools: { name: string; annotations?: Record<string, unknown> }[]) {
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
  for (const [name, hints] of Object.entries(BOX_TOOL_HINTS)) {
    expect({ name, annotations: byName[name] }).toEqual({ name, annotations: hints })
  }
  // It reaches reads and deletes alike, so it keeps the schema's destructive default.
  expect(byName.invoke_api_endpoint).toBeUndefined()
}

/** POSTs a raw body with the given headers. */
async function post(app: INestApplication, path: string, body: string, headers: Record<string, string>) {
  const server = app.getHttpServer()
  const { port } = server.address() ?? (await new Promise((r) => server.listen(0, () => r(server.address()))))
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body,
  })
  return { status: response.status, text: await response.text(), challenge: response.headers.get('www-authenticate') }
}

/**
 * Streams `megabytes` MiB chunked (no Content-Length) and resolves with the
 * response status, even when the server answers and closes before the upload ends.
 */
async function postChunked(app: INestApplication, path: string, megabytes: number, headers: Record<string, string>) {
  const server = app.getHttpServer()
  const { port } = server.address() ?? (await new Promise((r) => server.listen(0, () => r(server.address()))))
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      port,
      method: 'POST',
      path,
      headers: { ...headers, 'transfer-encoding': 'chunked' },
    })
    request.on('response', (response) => {
      // The server answered before the upload ended; stop sending so the
      // connection closes and the app can shut down.
      resolve(response.statusCode ?? 0)
      request.destroy()
    })
    request.on('error', (error) => reject(error))
    const chunk = Buffer.alloc(1024 * 1024, 'x')
    let sent = 0
    const pump = () => {
      while (sent < megabytes && !request.destroyed) {
        sent += 1
        if (!request.write(chunk)) return void request.once('drain', pump)
      }
      if (!request.destroyed) request.end()
    }
    pump()
  })
}

/** A `tools/list` call padded through `_meta` to exactly `bytes` bytes of JSON. */
function paddedCall(bytes: number): string {
  const shell = (pad: string) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { pad } } })
  return shell('x'.repeat(bytes - shell('').length))
}

describe('/mcp', () => {
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
    expectBoxToolHints(list.json.result.tools)
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
    expectBoxToolHints(list.json.result.tools)
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
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
    const allowed = await call(
      'invoke_api_endpoint',
      { operationId: 'configureSsh', arguments: { box_id: 'my-box', body: {} } },
      'Bearer good',
    )

    expect(allowed.status).toBe(200)
    expect(allowed.json.result.structuredContent).toEqual({ ssh: 'my-box' })
  })

  it('challenges an OAuth caller on an @All route that declares a permission', async () => {
    const denied = await call(
      'startExecution',
      { box_id: 'my-box', body: { command: 'true' }, wait: false },
      'Bearer oauth:read:volumes',
    )

    expect(denied.status).toBe(403)
  })

  it('takes a tool call larger than the default JSON body limit', async () => {
    const tar = Buffer.alloc(512 * 1024, 7)
    const uploaded = await call(
      'uploadFiles',
      { box_id: 'my-box', path: '/tmp', body_base64: tar.toString('base64') },
      'Bearer good',
    )

    expect(uploaded.status).toBe(200)
    expect(uploaded.json.result.structuredContent).toEqual({ bytes: tar.length })
  })

  it('reads execution output over the private socket even when the API serves TLS', async () => {
    const certPath = process.env.CERT_PATH
    process.env.CERT_PATH = '/etc/ssl/boxlite/api.pem'
    try {
      const run = await call('startExecution', { box_id: 'my-box', body: { command: 'echo 2' } }, 'Bearer good')

      expect(run.json.result.structuredContent).toMatchObject({ complete: true, exit_code: 0, stdout: '2\n' })
    } finally {
      if (certPath === undefined) delete process.env.CERT_PATH
      else process.env.CERT_PATH = certPath
    }
  })

  it('reads no body before authentication: an oversized unauthenticated call gets the counted 401', async () => {
    failedAuth.incrementFailedAuth.mockClear()

    const refused = await post(app, '/mcp', paddedCall(MCP_JSON_LIMIT_BYTES + 1), {
      'content-type': 'application/json',
    })

    expect(refused.status).toBe(401)
    expect(refused.challenge).toContain('Bearer')
    expect(failedAuth.incrementFailedAuth).toHaveBeenCalledTimes(1)
  })

  it('reads no chunked body before authentication either', async () => {
    const status = await postChunked(app, '/mcp', 13, { 'content-type': 'application/json' })

    expect(status).toBe(401)
  })

  it('takes an authenticated body up to the limit and answers 413 past it', async () => {
    const auth = { authorization: 'Bearer good', 'content-type': 'application/json' }

    const atLimit = await post(app, '/mcp', paddedCall(MCP_JSON_LIMIT_BYTES), auth)
    const overLimit = await post(app, '/mcp', paddedCall(MCP_JSON_LIMIT_BYTES + 1), auth)

    expect(atLimit.status).toBe(200)
    expect(overLimit.status).toBe(413)
  })

  it('keeps the parse error statuses for an authenticated caller', async () => {
    const auth = { authorization: 'Bearer good' }

    const badJson = await post(app, '/mcp', '{"jsonrpc":', { ...auth, 'content-type': 'application/json' })
    const badCharset = await post(app, '/mcp', '{}', {
      ...auth,
      'content-type': 'application/json; charset=latin1',
    })

    expect(badJson.status).toBe(400)
    expect(JSON.parse(badJson.text).message).toBe('Invalid JSON in request body')
    expect(badCharset.status).toBe(415)
  })

  it('leaves other routes on the default parsers', async () => {
    const json = { 'content-type': 'application/json' }

    const small = await post(app, '/api/echo', JSON.stringify({ hello: 'world' }), json)
    const large = await post(app, '/api/echo', JSON.stringify({ pad: 'x'.repeat(200 * 1024) }), json)

    expect(JSON.parse(small.text)).toEqual({ echoed: { hello: 'world' } })
    expect(large.status).toBe(413)
  })

  it('names no scope in the 401 challenge, so clients request scopes_supported', async () => {
    const { port } = app.getHttpServer().address()
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).not.toContain('scope=')
  })

  const request = (method: string, path: string) =>
    fetch(`http://127.0.0.1:${app.getHttpServer().address().port}${path}`, { method })

  it('serves MCP and its metadata outside the api prefix, and nothing at the prefixed paths', async () => {
    expect((await request('GET', '/.well-known/oauth-protected-resource/mcp')).status).toBe(200)
    expect((await request('GET', '/.well-known/oauth-protected-resource/api/mcp')).status).toBe(404)
    expect((await request('POST', '/api/mcp')).status).toBe(404)
  })

  it.each(['GET', 'DELETE'])('holds %s /mcp behind the MCP guards', async (method) => {
    expect((await request(method, '/mcp')).status).toBe(401)
  })

  it('runs the global middleware on /mcp', async () => {
    expect((await request('POST', '/mcp')).headers.get('x-global-middleware')).toBe('ran')
  })

  it('reads served routes from the Nest app under its global prefix', () => {
    const served = servedOperations(app.getHttpAdapter().getInstance(), () => false)

    expect(served({ method: 'get', path: '/api/v1/boxes/{box_id}', webSocket: false })).toBe(true)
    expect(served({ method: 'post', path: '/mcp', webSocket: false })).toBe(true)
    expect(served({ method: 'get', path: '/api/v1/boxes', webSocket: false })).toBe(false)
  })
})

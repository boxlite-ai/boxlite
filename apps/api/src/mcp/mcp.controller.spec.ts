/* Copyright 2026 BoxLite AI; SPDX-License-Identifier: AGPL-3.0 */
// Infrastructure modules are replaced below; keep their import graphs out of
// this HTTP test while exercising the real Passport strategies and MCP module.
jest.mock('../auth/auth.module', () => ({ AuthModule: class AuthModule {} }))
jest.mock('../organization/organization.module', () => ({ OrganizationModule: class OrganizationModule {} }))
jest.mock('../box/services/runner.service', () => ({ RunnerService: class RunnerService {} }))
jest.mock('../region/services/region.service', () => ({ RegionService: class RegionService {} }))
import { Controller, Get, Global, Module, Req, UseGuards, ForbiddenException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { Test } from '@nestjs/testing'
import { McpServer, MCP_OPENAPI } from './mcp-server'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { AuthModule } from '../auth/auth.module'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { FailedAuthTrackerService } from '../auth/failed-auth-tracker.service'
import { JwtStrategy } from '../auth/jwt.strategy'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { OrganizationModule } from '../organization/organization.module'
import { McpModule } from './mcp.module'
import { MCP_METADATA_PATH } from './mcp-auth'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { BoxliteBoxController } from '../boxlite-rest/boxlite-box.controller'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor'
import { BoxState } from '../box/enums/box-state.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'

@Controller('rest-auth-probe')
@UseGuards(CombinedAuthGuard)
class RestAuthProbe {
  @Get()
  get(@Req() request) {
    return { userId: request.user.userId }
  }
}

@Global()
@Module({})
class TestConfigModule {}
@Module({})
class TestAuthModule {}
@Module({})
class EmptyOrganizationModule {}

const resource = 'https://api.example.test/api/mcp'
const issuer = 'https://issuer.example.test/'
const account = { id: 'auth0|existing', email: 'member@example.test', emailVerified: true, role: 'user' }
const openapi = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
const toolOperations = [
  ['list_boxes', '/{prefix}/boxes', 'get'],
  ['get_box', '/{prefix}/boxes/{box_id}', 'get'],
  ['create_box', '/{prefix}/boxes', 'post'],
  ['start_box', '/{prefix}/boxes/{box_id}/start', 'post'],
  ['stop_box', '/{prefix}/boxes/{box_id}/stop', 'post'],
  ['delete_box', '/{prefix}/boxes/{box_id}', 'delete'],
]

describe('MCP HTTP resource server', () => {
  let app: any
  let jwks: Server
  let base: string
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
  let bearer: string
  const users = {
    findOne: jest.fn(async (id) => {
      if (revokeOnRest && ++userLookups > 1) return null
      return [account.id, 'auth0|second', 'auth0|restricted'].includes(id) ? { ...account, id } : null
    }),
    create: jest.fn(),
    update: jest.fn(),
  }
  const failedAuth = { incrementFailedAuth: jest.fn() }
  const box = { id: 'box-1', name: 'example', state: BoxState.STARTED, image: 'python:3.12-slim' }
  const boxes = {
    findAllDeprecated: jest.fn(async () => [box]),
    toBoxDtos: jest.fn(async (values) => values),
    findOneByIdOrName: jest.fn(async () => box),
    toBoxDtoWithExitCode: jest.fn(async (value) => value),
    create: jest.fn(async () => box),
    start: jest.fn(async () => box),
    stop: jest.fn(async () => box),
    toBoxDto: jest.fn(async (value) => value),
    destroy: jest.fn(async () => undefined),
  }
  const organizations = {
    findDefaultForUser: jest.fn(async (id) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'auth0|second' ? 1 : 10))
      return { id: id === 'auth0|second' ? 'org-second' : 'org-user' }
    }),
    findOne: jest.fn(async (id) => ({ id })),
  }
  const commerce = { resolveMaxCreatedBoxes: jest.fn(async () => 3) }
  const audit = { createLog: jest.fn(async () => ({ id: 'audit-1' })), updateLog: jest.fn() }
  const wire: Array<{ url: string; authorization: string; body: unknown; idempotency: string }> = []
  let revokeOnRest = false
  let userLookups = 0

  async function token(overrides: { aud?: string; iss?: string; exp?: number; sub?: string } = {}) {
    return new SignJWT(overrides.aud === 'rest' ? { email_verified: true, email: account.email, name: 'Member' } : {})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(overrides.iss ?? issuer)
      .setAudience(overrides.aud ?? resource)
      .setSubject(overrides.sub ?? account.id)
      .setIssuedAt()
      .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 120)
      .sign(privateKey)
  }

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256')
    privateKey = keys.privateKey
    const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
    jwks = createServer((_req, res) =>
      res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ keys: [publicKey] })),
    )
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
    const config = { get: (key: string) => ({ 'mcp.resourceUrl': resource, 'proxy.apiKey': 'machine-key' })[key] }
    const jwt = new JwtStrategy(
      {
        jwksUri: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`,
        issuer,
        audience: 'rest',
        mcpAudience: resource,
      },
      users as any,
      config as any,
      { recordFirstUse: jest.fn() } as any,
    )
    const apiKeys = new ApiKeyStrategy(
      { get: jest.fn(), setex: jest.fn() } as any,
      {
        getApiKeyByValue: jest.fn(async (value) => {
          if (!['organization-key', 'restricted-key'].includes(value)) throw new Error('Unknown key')
          return {
            userId: account.id,
            organizationId: 'org-key',
            name: 'test',
            permissions: value === 'restricted-key' ? [] : [Permission.WRITE_BOXES, Permission.DELETE_BOXES],
          }
        }),
        updateLastUsedAt: jest.fn(),
      } as any,
      users as any,
      config as any,
      { findByApiKey: jest.fn() } as any,
      { findOneByProxyApiKey: jest.fn() } as any,
    )
    const module = await Test.createTestingModule({
      imports: [
        McpModule,
        {
          module: TestConfigModule,
          providers: [{ provide: TypedConfigService, useValue: config }],
          exports: [TypedConfigService],
        },
      ],
      controllers: [RestAuthProbe, BoxliteBoxController],
      providers: [
        { provide: BoxService, useValue: boxes },
        { provide: BoxStateWaiterService, useValue: {} },
        { provide: CommerceBoxLimitService, useValue: commerce },
      ],
    })
      .overrideModule(AuthModule)
      .useModule({
        module: TestAuthModule,
        providers: [
          { provide: JwtStrategy, useValue: jwt },
          { provide: ApiKeyStrategy, useValue: apiKeys },
          { provide: FailedAuthTrackerService, useValue: failedAuth },
        ],
        exports: [JwtStrategy, FailedAuthTrackerService],
      })
      .overrideModule(OrganizationModule)
      .useModule({
        module: EmptyOrganizationModule,
        global: true,
        providers: [
          { provide: OrganizationService, useValue: organizations },
          {
            provide: OrganizationUserService,
            useValue: {
              findOne: async (id, userId) =>
                userId === 'auth0|restricted'
                  ? { role: 'member', assignedRoles: [] }
                  : (id === 'org-second') === (userId === 'auth0|second')
                    ? { role: 'owner' }
                    : null,
            },
          },
          { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
        ],
        exports: [OrganizationService, OrganizationUserService, getRedisConnectionToken()],
      })
      .overrideProvider(MCP_OPENAPI)
      .useValue(openapi)
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api', { exclude: [MCP_METADATA_PATH] })
    app.useBodyParser('json')
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), audit as any, config as any))
    app.use((req, _res, next) => {
      if (req.url.startsWith('/api/v1/'))
        wire.push({
          url: req.url,
          authorization: req.headers.authorization,
          body: req.body,
          idempotency: req.headers['idempotency-key'],
        })
      next()
    })
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`
    bearer = await token()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    if (jwks) await new Promise<void>((resolve) => jwks.close(() => resolve()))
  })

  async function call(method = 'tools/list', version = '2025-11-25', credential = bearer, params: object = {}) {
    return fetch(`${base}/api/mcp`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
    })
  }

  it('discovers Auth0 from a host-independent unauthenticated challenge', async () => {
    const response = await call('tools/list', '2025-11-25', '')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="https://api.example.test/${MCP_METADATA_PATH}"`,
    )
    expect(failedAuth.incrementFailedAuth).toHaveBeenCalled()
    const metadata = await fetch(`${base}/${MCP_METADATA_PATH}`)
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toEqual({ resource, authorization_servers: [issuer] })
  })

  it.each(['2025-03-26', '2025-06-18', '2025-11-25'])(
    'mounts generated tools for %s without persistent sessions',
    async (version) => {
      const response = await call('tools/list', version)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect((await response.json()).result.tools.map((tool) => tool.name).sort()).toEqual(
        toolOperations.map(([name]) => name).sort(),
      )
      expect(response.headers.get('mcp-session-id')).toBeNull()
    },
  )

  it('initializes the FastMCP server using the supported handshake', async () => {
    const response = await call('initialize', '2025-11-25', bearer, {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).result.serverInfo.name).toBe('boxlite')
  })

  it.each(['2025-11-25'])('rejects authenticated subscriptions as finite JSON for %s', async (version) => {
    const response = await call('subscriptions/listen', version, bearer, { notifications: {} })
    try {
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Subscriptions are not supported' },
      })
    } finally {
      if (!response.bodyUsed) await response.body?.cancel()
    }
  })

  it.each(['GET', 'HEAD', 'DELETE'])('does not open a %s stream or session', async (method) => {
    const response = await fetch(`${base}/api/mcp`, {
      method,
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(2000),
    })
    expect(response.status).toBe(405)
    await response.text()
  })

  it.each([
    { aud: 'wrong' },
    { aud: 'rest' },
    { iss: 'https://wrong.example.test/' },
    { exp: 1 },
    { sub: 'client@clients' },
    { sub: 'auth0|deleted' },
  ])('rejects unusable JWT claims %j', async (claims) => {
    const response = await call('tools/list', '2025-11-25', await token(claims))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
    await response.text()
  })

  it('rejects an invalid signature', async () => {
    const parts = bearer.split('.')
    parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1)
    expect((await call('tools/list', '2025-11-25', parts.join('.'))).status).toBe(401)
  })

  it('rejects organization API keys and machine credentials', async () => {
    expect((await call('tools/list', '2025-11-25', 'organization-key')).status).toBe(401)
    expect((await call('tools/list', '2025-11-25', 'machine-key')).status).toBe(401)
  })

  it('accepts the same claimless MCP token at the guarded REST interface without user writes', async () => {
    const response = await fetch(`${base}/api/rest-auth-probe`, { headers: { authorization: `Bearer ${bearer}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: account.id })
    expect(users.create).not.toHaveBeenCalled()
    expect(users.update).not.toHaveBeenCalled()
  })

  it('rejects browser origins after authentication', async () => {
    const response = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        origin: 'https://untrusted.example.test',
      },
    })
    expect(response.status).toBe(403)
  })

  async function tool(name: string, args: object = {}, credential = bearer) {
    const response = await call('tools/call', '2025-11-25', credential, { name, arguments: args })
    return { status: response.status, ...(await response.json()) }
  }

  it.each(toolOperations)(
    'advertises generated inputs, structured outputs and annotations for %s',
    async (name, path, method) => {
      const tools = (await (await call()).json()).result.tools
      const entry = tools.find((tool) => tool.name === name)
      expect(entry.inputSchema.properties).not.toHaveProperty('prefix')
      if (['create_box', 'stop_box'].includes(name)) expect(entry.inputSchema.properties).toHaveProperty('body')
      else expect(entry.inputSchema.properties).not.toHaveProperty('body')
      expect(entry.description).toBe(openapi.paths[path][method].summary)
      expect(entry.outputSchema.type).toBe('object')
      expect(entry.outputSchema.anyOf).toHaveLength(2)
      expect(entry.annotations.readOnlyHint).toBe(['list_boxes', 'get_box'].includes(name))
      expect(entry.annotations.destructiveHint).toBe(!entry.annotations.readOnlyHint)
      if (name === 'create_box') {
        expect(entry.inputSchema.$defs.CreateBoxRequest.properties).toHaveProperty('image')
        expect(entry.inputSchema.$defs.CreateBoxRequest.properties).toHaveProperty('advanced')
      }
    },
  )

  it('forwards omitted defaults, explicit values and idempotency through the existing controllers', async () => {
    wire.length = 0
    await tool('list_boxes')
    await tool('list_boxes', { pageSize: 2, pageToken: 'a/b?c', status: 'running' })
    const idempotency = '550e8400-e29b-41d4-a716-446655440000'
    const created = await tool('create_box', { body: { image: 'python:3.12-slim' }, 'Idempotency-Key': idempotency })
    expect(created.result.isError).not.toBe(true)
    expect(created.result.structuredContent.box_id).toBe(box.id)
    expect(wire.slice(-3)).toEqual([
      { url: '/api/v1/org-user/boxes', authorization: `Bearer ${bearer}`, body: undefined, idempotency: undefined },
      {
        url: '/api/v1/org-user/boxes?pageSize=2&pageToken=a%2Fb%3Fc&status=running',
        authorization: `Bearer ${bearer}`,
        body: undefined,
        idempotency: undefined,
      },
      {
        url: '/api/v1/org-user/boxes',
        authorization: `Bearer ${bearer}`,
        body: { image: 'python:3.12-slim' },
        idempotency,
      },
    ])
    expect(commerce.resolveMaxCreatedBoxes).toHaveBeenCalledWith('org-user')
    expect(boxes.create).toHaveBeenCalledWith(expect.anything(), { id: 'org-user' }, expect.anything(), {
      maxCreatedBoxes: 3,
    })
    expect(audit.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', organizationId: 'org-user', actorId: account.id }),
    )
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit-1',
      expect.objectContaining({ statusCode: 201, targetId: box.id }),
    )
  })

  it('uses all Box lifecycle routes and normalizes empty deletion success', async () => {
    wire.length = 0
    expect((await tool('list_boxes')).result.structuredContent.boxes[0].box_id).toBe(box.id)
    expect((await tool('get_box', { box_id: 'example' })).result.structuredContent.box_id).toBe(box.id)
    expect((await tool('stop_box', { box_id: box.id, body: { timeout_seconds: 0 } })).result.isError).not.toBe(true)
    expect((await tool('start_box', { box_id: box.id })).result.structuredContent.box_id).toBe(box.id)
    const deleted = (await tool('delete_box', { box_id: box.id, force: false })).result
    expect(deleted.isError).not.toBe(true)
    expect(deleted.structuredContent).toEqual({ status: 204 })
    expect(JSON.parse(deleted.content[0].text)).toEqual(deleted.structuredContent)
    expect(wire[2].body).toEqual({ timeout_seconds: 0 })
    expect(wire[4].url).toBe('/api/v1/org-user/boxes/box-1?force=false')
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }))
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }))
  })

  it('keeps credentials and default organizations separate during concurrent calls', async () => {
    wire.length = 0
    const second = await token({ sub: 'auth0|second' })
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => tool('list_boxes', {}, index % 2 ? second : bearer)),
    )
    expect(results.every((response) => !response.result.isError)).toBe(true)
    expect(wire).toHaveLength(12)
    for (const request of wire)
      expect(request.url).toBe(
        request.authorization === `Bearer ${second}` ? '/api/v1/org-second/boxes' : '/api/v1/org-user/boxes',
      )
  })

  it('enforces REST resource permissions and prevents organization injection', async () => {
    const restricted = await token({ sub: 'auth0|restricted' })
    for (const [name, args] of [
      ['create_box', { body: { image: 'python:3.12-slim' } }],
      ['stop_box', { box_id: box.id }],
      ['delete_box', { box_id: box.id }],
    ] as const) {
      const result = (await tool(name, args, restricted)).result
      expect(result.isError).toBe(true)
      expect(result.structuredContent.error).toMatchObject({ source: 'rest', status: 403 })
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    }
    const selected = await tool('list_boxes', { prefix: 'org-second' })
    expect(selected.error ?? selected.result?.isError).toBeTruthy()
  })

  it('revalidates the user on the REST hop', async () => {
    revokeOnRest = true
    userLookups = 0
    try {
      expect((await tool('list_boxes')).result.structuredContent.error.status).toBe(401)
      expect(userLookups).toBe(2)
    } finally {
      revokeOnRest = false
    }
  })

  it('retains detailed REST failures despite the successful output schema', async () => {
    commerce.resolveMaxCreatedBoxes.mockRejectedValueOnce(new ForbiddenException('Quota unavailable'))
    const before = boxes.create.mock.calls.length
    const result = (await tool('create_box', { body: { image: 'python:3.12-slim' } })).result
    expect(result.isError).toBe(true)
    expect(result.structuredContent.error).toMatchObject({
      source: 'rest',
      code: 'http_error',
      status: 403,
      message: 'Quota unavailable',
      details: { message: 'Quota unavailable' },
    })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(boxes.create).toHaveBeenCalledTimes(before)
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 403 }))
  })

  it.each([
    ['list_boxes', { pageSize: 0 }],
    ['list_boxes', { status: 'wrong' }],
    ['create_box', { body: { unexpected: true } }],
    ['get_box', { box_id: '' }],
    ['get_box', { box_id: '.' }],
    ['get_box', { box_id: '..' }],
  ])('rejects invalid input for %s before REST dispatch', async (name: string, args: object) => {
    const before = wire.length
    const result = await tool(name, args)
    expect(result.error ?? result.result?.isError).toBeTruthy()
    expect(wire).toHaveLength(before)
  })

  it('releases every per-request FastMCP session', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(app.get(McpServer).sessions).toHaveLength(0)
  })
})

import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { INestApplication, RequestTimeoutException } from '@nestjs/common'
import { AddressInfo } from 'node:net'
import { createServer, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { SignJWT } from 'jose'
import { AuditInterceptor } from './interceptors/audit.interceptor'
import { AuditService } from './services/audit.service'
import { BoxliteProxyController } from '../boxlite-rest/boxlite-proxy.controller'
import { BoxliteVolumeController } from '../boxlite-rest/boxlite-volume.controller'
import { BoxliteDomainController } from '../boxlite-rest/boxlite-domain.controller'
import { BoxliteImageController } from '../boxlite-rest/boxlite-image.controller'
import { DomainService } from '../box/services/domain.service'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { BoxService } from '../box/services/box.service'
import { VolumeService } from '../box/services/volume.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { TunnelService } from '../box/services/tunnel.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { VolumeAccessGuard } from '../box/guards/volume-access.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AccountLinkService, ADOPT_AUDIENCE } from '../auth/account-link.service'
import { Context } from '../common/context/context'

// Use Node's loader for the published ESM proxy, preserving real HTTP behavior.
jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

describe('audit refinement contracts', () => {
  let app: INestApplication
  let upstream: Server
  let base: string
  let audit: { createLog: jest.Mock; updateLog: jest.Mock; keepPendingLogAlive: jest.Mock }
  let volume: { delete: jest.Mock; create: jest.Mock; waitForReady: jest.Mock }
  let releaseResponse: (() => void) | undefined
  let upstreamStarted: Promise<void>
  let started: () => void
  let serverResponse: ServerResponse

  beforeEach(async () => {
    upstreamStarted = new Promise((resolve) => (started = resolve))
    upstream = createServer((req, res) => {
      req.resume()
      if (req.url?.endsWith('/exec')) {
        res.writeHead(202)
        res.write('running\n')
        releaseResponse = () => res.end('done\n')
        started()
      } else {
        res.writeHead(req.url?.includes('/signal') ? 409 : 204)
        res.end()
      }
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    audit = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      updateLog: jest.fn().mockResolvedValue({}),
      keepPendingLogAlive: jest.fn(async () => ({
        signal: new AbortController().signal,
        complete: (result) => audit.updateLog('audit-1', result),
      })),
    }
    volume = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({ id: 'volume-id' }),
      waitForReady: jest.fn().mockResolvedValue({
        id: 'volume-id',
        name: 'volume',
        state: 'ready',
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    }
    const module = await Test.createTestingModule({
      controllers: [BoxliteProxyController, BoxliteVolumeController, BoxliteDomainController, BoxliteImageController],
      providers: [
        {
          provide: BoxService,
          useValue: {
            findOneByIdOrName: jest.fn().mockResolvedValue({
              id: 'box-id',
              runnerId: 'runner',
              autoResume: false,
              state: 'started',
              desiredState: 'started',
              inboundEnabled: true,
            }),
            updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
            getNetworkTunnelUrl: jest.fn().mockResolvedValue('https://tunnel.example.test'),
          },
        },
        {
          provide: RunnerService,
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              apiUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
              apiKey: 'runner-secret',
            }),
          },
        },
        { provide: BoxAutoResumeService, useValue: {} },
        {
          provide: TunnelService,
          useValue: { prepare: jest.fn().mockResolvedValue({ token: 'private-tunnel-secret' }), revoke: jest.fn() },
        },
        { provide: VolumeService, useValue: volume },
        {
          provide: DomainService,
          useValue: {
            claim: jest.fn().mockResolvedValue({ hostname: 'hello.example.test' }),
            bind: jest.fn().mockResolvedValue({ hostname: 'hello.example.test' }),
            owned: jest.fn().mockResolvedValue({ target: null }),
            unbind: jest.fn(),
          },
        },
        { provide: ImageCatalogService, useValue: { delete: jest.fn() } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = {
            userId: 'user',
            email: 'user@example.test',
            organizationId: 'org',
            organization: { id: 'org' },
            role: 'user',
            organizationUser: { role: 'owner', assignedRoles: [] },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(VolumeAccessGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.use((_req: unknown, res: ServerResponse, next: () => void) => {
      serverResponse = res
      next()
    })
    app.useGlobalInterceptors(new (AuditInterceptor as any)(new Reflector(), audit, { get: jest.fn() }))
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  })

  afterEach(async () => {
    releaseResponse?.()
    releaseResponse = undefined
    await app?.close()
    upstream?.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  async function flushAudit() {
    // Drain event-loop callbacks, without guessing a network/database sleep.
    for (let i = 0; i < 10 && audit.updateLog.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  it.each(['/v1/volumes/volume-id', '/v1/tenant/volumes/volume-id'])(
    'audits volume deletion through %s',
    async (path) => {
      const res = await fetch(base + path, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(volume.delete).toHaveBeenCalledWith('volume-id', Context.user({ userId: 'user', authMethod: 'jwt' }), false)
      expect(audit.createLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', targetId: 'volume-id', organizationId: 'org' }),
      )
      expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 204 }))
    },
  )

  it.each(['/v1/volumes', '/v1/tenant/volumes'])(
    'keeps the created volume target on timeout through %s',
    async (path) => {
      volume.waitForReady.mockRejectedValue(new RequestTimeoutException('volume not ready'))
      const res = await fetch(base + path, { method: 'POST' })
      expect(res.status).toBe(408)
      expect(volume.create).toHaveBeenCalledTimes(1)
      expect(audit.updateLog).toHaveBeenCalledWith(
        'audit-1',
        expect.objectContaining({ targetId: 'volume-id', statusCode: 408 }),
      )
    },
  )

  it.each(['/v1/domains', '/v1/tenant/domains'])(
    'audits canonical domain unbinding as an update through %s',
    async (path) => {
      const query = jest.fn().mockImplementation((sql: string) =>
        Promise.resolve(sql.startsWith('UPDATE "domain"') ? [[], 1] : []),
      )
      const domains = app.get(DomainService)
      Object.assign(domains, {
        dataSource: { transaction: (work: (manager: unknown) => Promise<unknown>) => work({ query }) },
        fullHostname: (DomainService.prototype as any).fullHostname,
        assertManagedDomain: (DomainService.prototype as any).assertManagedDomain,
      })
      domains.unbind = DomainService.prototype.unbind
      const res = await fetch(base + path + '/HELLO.example.test./target', { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "domain"'), ['hello.example.test', 'org'])
      expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', targetType: 'domain' }))
      expect(audit.updateLog).toHaveBeenCalledWith(
        'audit-1',
        expect.objectContaining({ targetId: 'hello.example.test', statusCode: 204 }),
      )
    },
  )

  it('does not perform a mutation if creating its audit fails', async () => {
    audit.createLog.mockRejectedValue(new Error('database unavailable'))
    const res = await fetch(base + '/v1/volumes/volume-id', { method: 'DELETE' })
    expect(res.status).toBe(500)
    expect(volume.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['POST', '/v1/volumes', {}, 'volume', 'volume-id', 201],
    ['POST', '/v1/domains', { name: 'hello' }, 'domain', 'hello.example.test', 201],
    [
      'PUT',
      '/v1/domains/hello.example.test/target',
      { type: 'box', box: 'mybox', port: 3000 },
      'domain',
      'hello.example.test',
      200,
    ],
    ['DELETE', '/v1/domains/hello.example.test/target', undefined, 'domain', 'hello.example.test', 204],
    ['DELETE', '/v1/images/myimage', undefined, 'image', 'myimage', 204],
    ['POST', '/v1/boxes/mybox/network/tunnel?port=3000', { isPublic: false }, 'box', 'box-id', 200],
    ['DELETE', '/v1/boxes/mybox/network/tunnel?port=3000', undefined, 'box', 'box-id', 204],
  ] as const)('audits %s %s with its resolved target', async (method, path, body, targetType, targetId, statusCode) => {
    const res = await fetch(base + path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(statusCode)
    await res.text()
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ targetType }))
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ targetId, statusCode }))
    expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('private-tunnel-secret')
  })

  it.each([
    ['PUT', '/files'],
    ['DELETE', '/executions/exec-id'],
    ['POST', '/ssh'],
    ['POST', '/ssh/enable'],
    ['DELETE', '/ssh'],
  ])('audits proxy write %s %s', async (method, path) => {
    const res = await fetch(base + '/v1/boxes/mybox' + path, {
      method,
      body: method === 'DELETE' ? undefined : 'private-file-contents',
    })
    expect(res.status).toBe(204)
    await flushAudit()
    expect(audit.createLog).toHaveBeenCalledTimes(1)
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit-1',
      expect.objectContaining({ targetId: 'box-id', statusCode: 204 }),
    )
    expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('private-file-contents')
  })

  it('records a streaming execution only after the response finishes, without request contents', async () => {
    const request = fetch(base + '/v1/boxes/mybox/exec', {
      method: 'POST',
      body: JSON.stringify({ command: 'secret-command' }),
      headers: { 'Content-Type': 'application/json' },
    })
    await upstreamStarted
    const response = await request
    expect(audit.createLog).toHaveBeenCalledTimes(1)
    expect(audit.updateLog).not.toHaveBeenCalled()
    releaseResponse!()
    expect(await response.text()).toContain('done')
    await flushAudit()
    expect(audit.updateLog).toHaveBeenCalledTimes(1)
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit-1',
      expect.objectContaining({ statusCode: 202, targetId: 'box-id' }),
    )
    expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('secret-command')
    expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('runner-secret')
  })

  it('closes the stream and completes once when its audit lease fails', async () => {
    const lease = new AbortController()
    const remove = jest.spyOn(lease.signal, 'removeEventListener')
    audit.keepPendingLogAlive.mockResolvedValue({
      signal: lease.signal,
      complete: (result) => audit.updateLog('audit-1', result),
    })
    const request = fetch(base + '/v1/boxes/mybox/exec', { method: 'POST' })
    await upstreamStarted
    const response = await request
    const closed = once(serverResponse, 'close')
    lease.abort(new Error('renewal failed'))
    await closed
    await expect(response.text()).rejects.toThrow()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(audit.updateLog).toHaveBeenCalledTimes(1)
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 0 }))
  })

  it('refuses forwarding if the response audit lease cannot be acquired', async () => {
    audit.keepPendingLogAlive.mockRejectedValue(new Error('lease unavailable'))
    const response = await fetch(base + '/v1/boxes/mybox/exec', { method: 'POST' })
    expect(response.status).toBe(500)
    expect(releaseResponse).toBeUndefined()
  })

  it('records an interrupted stream as unknown, once', async () => {
    const abort = new AbortController()
    const request = fetch(base + '/v1/boxes/mybox/exec', { method: 'POST', signal: abort.signal })
    await upstreamStarted
    const response = await request
    abort.abort()
    await response.text().catch(() => undefined)
    await flushAudit()
    expect(audit.updateLog).toHaveBeenCalledTimes(1)
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 0 }))
  })

  it('does not forward after the client disconnects during the initial audit insert', async () => {
    let inserted!: (value: unknown) => void
    let entered!: () => void
    const inserting = new Promise<void>((resolve) => (entered = resolve))
    audit.createLog.mockImplementation(() => {
      entered()
      return new Promise((resolve) => (inserted = resolve))
    })
    let completed!: () => void
    const recorded = new Promise<void>((resolve) => (completed = resolve))
    audit.updateLog.mockImplementation(async () => {
      completed()
      return {}
    })
    const abort = new AbortController()
    const request = fetch(base + '/v1/boxes/mybox/exec', { method: 'POST', signal: abort.signal }).catch(
      () => undefined,
    )
    await inserting
    const closed = once(serverResponse, 'close')
    abort.abort()
    await request
    await closed
    inserted({ id: 'audit-1' })
    await recorded
    expect(releaseResponse).toBeUndefined()
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 0 }))
  })

  it('claims completion before awaiting a slow audit update', async () => {
    let release!: (value: unknown) => void
    let entered!: () => void
    const updating = new Promise<void>((resolve) => (entered = resolve))
    audit.updateLog.mockImplementation(() => {
      entered()
      return new Promise((resolve) => (release = resolve))
    })
    const request = fetch(base + '/v1/boxes/mybox/exec', { method: 'POST' })
    await upstreamStarted
    const closed = once(serverResponse, 'close')
    releaseResponse!()
    await (await request).text()
    await updating
    await closed
    expect(audit.updateLog).toHaveBeenCalledTimes(1)
    release({})
  })

  it('records upstream refusal, and excludes file reads and terminal resize', async () => {
    const res = await fetch(base + '/v1/boxes/mybox/executions/exec-id/signal', { method: 'POST' })
    expect(res.status).toBe(409)
    await flushAudit()
    expect(audit.updateLog).toHaveBeenCalledWith('audit-1', expect.objectContaining({ statusCode: 409 }))
    audit.createLog.mockClear()
    await fetch(base + '/v1/boxes/mybox/files')
    await fetch(base + '/v1/boxes/mybox/executions/exec-id/resize', { method: 'POST' })
    expect(audit.createLog).not.toHaveBeenCalled()
  })
})

it('persists unknown status through AuditService rather than discarding zero', async () => {
  const row = { id: 'audit-1', statusCode: null }
  const repo = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn(async (value) => value) }
  const service = new (AuditService as any)(repo, { get: () => false }) as AuditService
  expect((await service.updateLog('audit-1', { statusCode: 0 })).statusCode).toBe(0)
})

it('audits verified account adoption before migration and records only local success', async () => {
  const secret = 'audit-test-key-'.repeat(4)
  const audit = {
    createLog: jest.fn().mockResolvedValue({ id: 'link-audit' }),
    updateLog: jest.fn().mockResolvedValue({}),
  }
  const linked = {
    adopt: jest.fn(async () => {
      expect(audit.createLog).toHaveBeenCalledTimes(1)
    }),
  }
  const service = new (AccountLinkService as any)({ getOrThrow: () => secret }, linked, {}, audit) as AccountLinkService
  const token = await new SignJWT({ sub: 'auth0|secondary', primary_user_id: 'auth0|primary' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(ADOPT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(secret))
  await service.adopt(token)
  expect(audit.createLog).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: 'auth0|primary', targetId: 'auth0|secondary', source: 'auth0-account-link' }),
  )
  expect(audit.updateLog).toHaveBeenCalledWith('link-audit', expect.objectContaining({ statusCode: 204 }))
  expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain(token)
})

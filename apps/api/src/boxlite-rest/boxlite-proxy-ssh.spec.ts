/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type { AddressInfo } from 'net'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { BodyParserErrorModule } from '../common/modules/body-parser-error.module'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { BoxliteProxyController } from './boxlite-proxy.controller'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

const auth = { organizationId: 'org-1', organization: { id: 'org-1', suspended: false } } as never
const running = { state: 'started', desiredState: 'started' }

function makeHarness(box: Record<string, unknown>) {
  const proxyHandler = jest.fn()
  jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1', autoResume: true, ...box }),
    updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
  }
  const runnerService = { findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'k' }) }
  const autoResume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
  const controller = new BoxliteProxyController(
    boxService as never,
    runnerService as never,
    autoResume as never,
    {} as never,
  )
  const call = (route: 'configureSsh' | 'getSshStatus' | 'disableSsh') =>
    controller[route](auth, 'my-box', { url: '/ssh' } as never, {} as never, jest.fn())
  return { call, boxService, autoResume, proxyHandler }
}

function proxiedPath(): string {
  const options = jest.mocked(createProxyMiddleware).mock.calls[0][0]
  return (options.pathRewrite as (path: string, req: unknown) => string)('/ignored', {})
}

describe('BoxliteProxyController SSH routes', () => {
  beforeEach(() => jest.clearAllMocks())

  describe('configureSsh', () => {
    it('proxies a running box exactly once, counting it as activity', async () => {
      const { call, boxService, autoResume, proxyHandler } = makeHarness(running)

      await call('configureSsh')

      expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('my-box', 'org-1')
      expect(boxService.updateLastActivityAt).toHaveBeenCalledWith('box-uuid', expect.any(Date))
      expect(autoResume.ensureReady).toHaveBeenCalledTimes(1)
      expect(createProxyMiddleware).toHaveBeenCalledTimes(1)
      expect(proxyHandler).toHaveBeenCalledTimes(1)
      expect(proxiedPath()).toBe('/v1/boxes/box-uuid/ssh')
    })

    it('resumes a stopped box that runs its image default command', async () => {
      const { call, autoResume, proxyHandler } = makeHarness({ state: 'stopped', desiredState: 'stopped' })

      await call('configureSsh')

      expect(autoResume.ensureReady).toHaveBeenCalledWith('box-uuid', expect.anything(), expect.any(Function))
      expect(proxyHandler).toHaveBeenCalledTimes(1)
    })

    describe.each(['stopped', 'unknown'])('with a stored %s state and desired started', (state) => {
      it.each(['cmd', 'entrypoint'])('waits for the submitted start with an explicit %s', async (command) => {
        const { call, boxService, autoResume, proxyHandler } = makeHarness({
          state,
          desiredState: 'started',
          pending: false,
          [command]: ['/init'],
        })
        const conditionalStartForProxy = jest.fn()
        Object.assign(boxService, {
          organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
          boxRepository: { conditionalStartForProxy },
          eventEmitter: { emit: jest.fn() },
          ensureStartedForProxy: BoxService.prototype.ensureStartedForProxy.bind(boxService),
        })
        let finishStart!: () => void
        const started = new Promise<void>((resolve) => (finishStart = resolve))
        let observeWait!: () => void
        const waiting = new Promise<void>((resolve) => (observeWait = resolve))
        const waitForStarted = jest.fn(() => {
          observeWait()
          return started
        })
        const lock = { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) }
        const resume = new BoxAutoResumeService(boxService as never, { waitForStarted } as never, lock as never)
        autoResume.ensureReady.mockImplementation(resume.ensureReady.bind(resume))

        const request = call('configureSsh')
        try {
          await Promise.race([waiting, request])
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(waitForStarted).toHaveBeenCalledWith('box-uuid', 'org-1', 30)
          expect(waitForStarted).toHaveBeenCalledTimes(1)
          expect(boxService.findOneByIdOrName).toHaveBeenCalledTimes(2)
          expect(createProxyMiddleware).not.toHaveBeenCalled()
          expect(proxyHandler).not.toHaveBeenCalled()
          expect(conditionalStartForProxy).not.toHaveBeenCalled()
        } finally {
          finishStart()
          await request
        }

        expect(createProxyMiddleware).toHaveBeenCalledTimes(1)
        expect(proxyHandler).toHaveBeenCalledTimes(1)
        expect(conditionalStartForProxy).not.toHaveBeenCalled()
        expect(lock.unlock).toHaveBeenCalledTimes(1)
      })
    })

    it('refuses a custom-command box that stops before the resume lock is acquired', async () => {
      const { call, boxService, autoResume, proxyHandler } = makeHarness(running)
      const initial = { id: 'box-uuid', runnerId: 'runner-1', autoResume: true, cmd: ['sleep'], ...running }
      const stopped = { ...initial, state: 'stopped', desiredState: 'stopped', pending: false }
      boxService.findOneByIdOrName.mockResolvedValueOnce(initial).mockResolvedValue(stopped)
      const conditionalStartForProxy = jest
        .fn()
        .mockResolvedValue({ ...stopped, desiredState: 'started', pending: true })
      Object.assign(boxService, {
        organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
        boxRepository: { conditionalStartForProxy },
        eventEmitter: { emit: jest.fn() },
        ensureStartedForProxy: BoxService.prototype.ensureStartedForProxy.bind(boxService),
      })
      const lock = { lock: jest.fn().mockResolvedValue(true), unlock: jest.fn().mockResolvedValue(undefined) }
      const resume = new BoxAutoResumeService(
        boxService as never,
        { waitForStarted: jest.fn().mockResolvedValue(undefined) } as never,
        lock as never,
      )
      autoResume.ensureReady.mockImplementation(resume.ensureReady.bind(resume))

      await expect(call('configureSsh')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('explicit cmd'),
      })
      expect(conditionalStartForProxy).not.toHaveBeenCalled()
      expect(proxyHandler).not.toHaveBeenCalled()
      expect(lock.unlock).toHaveBeenCalled()
    })

    it.each([
      [
        'auto-resume is off',
        { state: 'stopped', desiredState: 'stopped', autoResume: false },
        'auto-resume is disabled',
      ],
      [
        'auto-resume is off during a submitted start',
        { state: 'stopped', desiredState: 'started', autoResume: false, cmd: ['sleep'] },
        'auto-resume is disabled',
      ],
      [
        'auto-resume is off during creation',
        { state: 'unknown', desiredState: 'started', autoResume: false, entrypoint: ['/init'] },
        'auto-resume is disabled',
      ],
      [
        'a stopped box has an explicit cmd',
        { state: 'stopped', desiredState: 'stopped', cmd: ['sleep'] },
        'explicit cmd',
      ],
      [
        'a stopped box has an explicit entrypoint',
        { state: 'stopped', desiredState: 'stopped', entrypoint: ['/init'] },
        'explicit cmd',
      ],
      [
        'a stopping box has an entrypoint',
        { state: 'stopping', desiredState: 'stopped', entrypoint: ['/init'] },
        'explicit cmd',
      ],
      [
        'a started box being stopped has a cmd',
        { state: 'started', desiredState: 'stopped', cmd: ['sleep'] },
        'explicit cmd',
      ],
      ['the box cannot resume', { state: 'error', desiredState: 'started' }, 'is not running'],
    ])('refuses with 409 when %s, after recording activity', async (_case, box, message) => {
      const { call, boxService, autoResume, proxyHandler } = makeHarness(box)

      await expect(call('configureSsh')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(message),
      })
      expect(boxService.updateLastActivityAt).toHaveBeenCalled()
      expect(autoResume.ensureReady).not.toHaveBeenCalled()
      expect(proxyHandler).not.toHaveBeenCalled()
    })

    it.each(['creating', 'starting', 'restoring'])(
      'joins a start already in flight (%s) even with an explicit cmd',
      async (state) => {
        const { call, autoResume, proxyHandler } = makeHarness({ state, desiredState: 'started', cmd: ['sleep'] })

        await call('configureSsh')

        expect(autoResume.ensureReady).toHaveBeenCalledTimes(1)
        expect(proxyHandler).toHaveBeenCalledTimes(1)
      },
    )
  })

  describe.each(['getSshStatus', 'disableSsh'] as const)('%s', (route) => {
    it.each(['started', 'stopped'])('proxies a %s box without activity or resume', async (state) => {
      const { call, boxService, autoResume, proxyHandler } = makeHarness({ state, desiredState: state })

      await call(route)

      expect(proxyHandler).toHaveBeenCalledTimes(1)
      expect(proxiedPath()).toBe('/v1/boxes/box-uuid/ssh')
      expect(boxService.updateLastActivityAt).not.toHaveBeenCalled()
      expect(autoResume.ensureReady).not.toHaveBeenCalled()
    })

    it.each(['starting', 'stopping', 'creating', 'error', 'archived'])('refuses a %s box with 409', async (state) => {
      const { call, autoResume, proxyHandler } = makeHarness({ state, desiredState: 'started' })

      await expect(call(route)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(state) })
      expect(autoResume.ensureReady).not.toHaveBeenCalled()
      expect(proxyHandler).not.toHaveBeenCalled()
    })
  })

  it.each(['configureSsh', 'getSshStatus', 'disableSsh'] as const)(
    '%s answers 404 for a box outside the organization',
    async (route) => {
      const { call, boxService, proxyHandler } = makeHarness(running)
      boxService.findOneByIdOrName.mockRejectedValue(new NotFoundException('Box my-box not found'))

      await expect(call(route)).rejects.toMatchObject({ status: 404 })
      expect(boxService.updateLastActivityAt).not.toHaveBeenCalled()
      expect(proxyHandler).not.toHaveBeenCalled()
    },
  )
})

type SshApp = { app: INestApplication; findOneByIdOrName: jest.Mock; updateLastActivityAt: jest.Mock }

// A Nest app around the proxy controller. With `principal` the real
// OrganizationResourceActionGuard checks that caller's key; without it every
// caller is admitted.
async function startSshApp(principal?: Record<string, unknown>): Promise<SshApp> {
  jest.clearAllMocks()
  const findOneByIdOrName = jest
    .fn()
    .mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1', autoResume: true, ...running })
  const updateLastActivityAt = jest.fn().mockResolvedValue(undefined)
  // Stand in for the runner: answer with what the proxy would have sent.
  jest.mocked(createProxyMiddleware).mockImplementation(
    (options) =>
      ((req: any, res: any) =>
        res.status(200).json({
          method: req.method,
          path: (options.pathRewrite as (path: string, req: unknown) => string)(req.url, req),
          body: req.body,
        })) as never,
  )
  let builder = Test.createTestingModule({
    imports: [BodyParserErrorModule],
    controllers: [BoxliteProxyController],
    providers: [
      { provide: BoxService, useValue: { findOneByIdOrName, updateLastActivityAt } },
      { provide: RunnerService, useValue: { findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local' }) } },
      { provide: BoxAutoResumeService, useValue: { ensureReady: jest.fn().mockResolvedValue(undefined) } },
      { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
      {
        provide: OrganizationUserService,
        useValue: {
          findOne: async (organizationId: string, userId: string) => ({ organizationId, userId, role: 'member' }),
        },
      },
      { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
    ],
  })
    .useMocker(() => ({}))
    .overrideGuard(CombinedAuthGuard)
    .useValue({
      canActivate: (context: any) => {
        context.switchToHttp().getRequest().user = principal ?? {
          organizationId: 'org-1',
          organization: { id: 'org-1' },
        }
        return true
      },
    })
    .overrideGuard(AuthenticatedRateLimitGuard)
    .useValue({ canActivate: () => true })
  if (!principal) {
    builder = builder.overrideGuard(OrganizationResourceActionGuard).useValue({ canActivate: () => true })
  }
  const app = (await builder.compile()).createNestApplication()
  app.setGlobalPrefix('api')
  await app.listen(0)
  return { app, findOneByIdOrName, updateLastActivityAt }
}

function send(app: INestApplication, method: string, path: string, body?: string): Promise<Response> {
  const address = app.getHttpServer().address() as AddressInfo
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body,
  })
}

const sshConfig = { listen_address: '0.0.0.0:2222', host_private_key: 'k', accounts: [{ login: 'alice' }] }

describe('SSH REST routing', () => {
  let ssh: SshApp

  beforeEach(async () => {
    ssh = await startSshApp()
  })

  afterEach(async () => {
    await ssh?.app.close()
  })

  it.each(['/api/v1/boxes/my-box/ssh', '/api/v1/default/boxes/my-box/ssh'])(
    'routes every SSH method on %s to the runner by internal id',
    async (path) => {
      for (const [method, body] of [
        ['POST', sshConfig],
        ['GET', undefined],
        ['DELETE', undefined],
      ] as const) {
        const response = await send(ssh.app, method, path, body && JSON.stringify(body))

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ method, path: '/v1/boxes/box-uuid/ssh', ...(body && { body }) })
      }
      expect(ssh.findOneByIdOrName).toHaveBeenCalledWith('my-box', 'org-1')
    },
  )

  it('rejects malformed JSON without echoing it', async () => {
    const response = await send(
      ssh.app,
      'POST',
      '/api/v1/boxes/my-box/ssh',
      '{"host_private_key":"PRIVATE-KEY-MATERIAL',
    )

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('PRIVATE-KEY-MATERIAL')
    expect(ssh.findOneByIdOrName).not.toHaveBeenCalled()
  })
})

describe('SSH REST permissions', () => {
  let ssh: SshApp

  beforeEach(async () => {
    // A member's API key that holds no box permission.
    ssh = await startSshApp({
      userId: 'member',
      role: 'user',
      organizationId: 'org-1',
      apiKey: { organizationId: 'org-1', permissions: [] },
    })
  })

  afterEach(async () => {
    await ssh?.app.close()
  })

  it.each([
    ['POST', JSON.stringify(sshConfig)],
    ['DELETE', undefined],
  ])('refuses %s without write:boxes before any activity or proxying', async (method, body) => {
    const response = await send(ssh.app, method, '/api/v1/boxes/my-box/ssh', body)

    expect(response.status).toBe(403)
    expect(ssh.findOneByIdOrName).not.toHaveBeenCalled()
    expect(ssh.updateLastActivityAt).not.toHaveBeenCalled()
    expect(createProxyMiddleware).not.toHaveBeenCalled()
  })

  it('lets any member read SSH status', async () => {
    const response = await send(ssh.app, 'GET', '/api/v1/boxes/my-box/ssh')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: 'GET', path: '/v1/boxes/box-uuid/ssh' })
  })
})

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createProxyMiddleware } from 'http-proxy-middleware'
import type { IncomingMessage } from 'http'
import { EventEmitter } from 'events'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => ({
    upgrade: jest.fn(),
  })),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

describe('BoxliteWsProxyService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function authRequest(token: string, url = '/api/v1/org-1/boxes/public-box/executions/exec-1/attach') {
    return {
      url,
      headers: {
        authorization: `Bearer ${token}`,
      },
    } as IncomingMessage
  }

  function buildAuthHarness() {
    const apiKeyService = {
      getApiKeyByValue: jest.fn().mockRejectedValue(new Error('api key not found')),
    }
    const organizationUserService = {
      findOne: jest.fn(),
    }
    const jwtStrategy = {
      verifyToken: jest.fn(),
    }
    const service = new BoxliteWsProxyService(
      apiKeyService as never,
      organizationUserService as never,
      {} as never,
      {} as never,
      jwtStrategy as never,
    ) as unknown as {
      authenticate: (req: IncomingMessage, urlTenant?: string) => Promise<{ organizationId: string } | null>
    }

    return { service, apiKeyService, organizationUserService, jwtStrategy }
  }

  it('rewrites public box ids to internal box ids before proxying attach upgrades to the runner', () => {
    new BoxliteWsProxyService({} as never, {} as never, {} as never, {} as never, {} as never)

    const proxyOptions = jest.mocked(createProxyMiddleware).mock.calls[0][0]
    const pathRewrite = proxyOptions.pathRewrite as (path: string, req: unknown) => string
    const req = { __boxliteRunnerBoxId: 'box-uuid' }

    expect(pathRewrite('/api/v1/boxes/public-box/executions/exec-1/attach', req)).toBe(
      '/v1/boxes/box-uuid/executions/exec-1/attach',
    )
    expect(pathRewrite('/api/v1/default/boxes/public-box/executions/exec-1/attach?x=1', req)).toBe(
      '/v1/boxes/box-uuid/executions/exec-1/attach?x=1',
    )
  })

  it('authenticates API key bearer tokens for websocket attach', async () => {
    const { service, apiKeyService, organizationUserService, jwtStrategy } = buildAuthHarness()
    apiKeyService.getApiKeyByValue.mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      expiresAt: null,
    })
    organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })

    await expect(service.authenticate(authRequest('blk_live_test'))).resolves.toEqual({ organizationId: 'org-1' })
    expect(organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'user-1')
    expect(jwtStrategy.verifyToken).not.toHaveBeenCalled()
  })

  it('authenticates JWT bearer tokens for websocket attach', async () => {
    const { service, organizationUserService, jwtStrategy } = buildAuthHarness()
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature'
    jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1', email: 'dev@acme.test' })
    organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })

    await expect(service.authenticate(authRequest(jwt), 'org-1')).resolves.toEqual({ organizationId: 'org-1' })
    expect(jwtStrategy.verifyToken).toHaveBeenCalledWith(jwt)
    expect(organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'user-1')
  })

  it('rejects invalid JWT bearer tokens for websocket attach', async () => {
    const { service, organizationUserService, jwtStrategy } = buildAuthHarness()
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature'
    jwtStrategy.verifyToken.mockRejectedValue(new Error('bad jwt'))

    await expect(service.authenticate(authRequest(jwt), 'org-1')).resolves.toBeNull()
    expect(organizationUserService.findOne).not.toHaveBeenCalled()
  })

  it('rejects JWT attach when organization membership has been removed', async () => {
    const { service, organizationUserService, jwtStrategy } = buildAuthHarness()
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature'
    jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1', email: 'dev@acme.test' })
    organizationUserService.findOne.mockResolvedValue(null)

    await expect(service.authenticate(authRequest(jwt), 'org-1')).resolves.toBeNull()
    expect(organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'user-1')
  })

  function buildUpgradeHarness() {
    jest.useFakeTimers()
    const upgrade = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue({ upgrade } as never)

    const boxService = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-uuid',
        runnerId: 'runner-1',
      }),
      updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    }
    const runnerService = {
      findOne: jest.fn().mockResolvedValue({
        apiUrl: 'http://runner.local',
        apiKey: 'runner-key',
      }),
    }
    const service = new BoxliteWsProxyService(
      {} as never,
      {} as never,
      boxService as never,
      runnerService as never,
      {} as never,
    )
    jest.spyOn(service as any, 'authenticate').mockResolvedValue({ organizationId: 'org-1' })

    const socket = new EventEmitter() as EventEmitter & {
      destroy: jest.Mock
      write: jest.Mock
    }
    socket.destroy = jest.fn()
    socket.write = jest.fn()

    return { service, boxService, upgrade, socket }
  }

  it('does not refresh activity from proxied websocket bytes after the upgrade touch', async () => {
    const { service, boxService, upgrade, socket } = buildUpgradeHarness()

    await service.upgrade(authRequest('blk_live_test'), socket as never, Buffer.alloc(0))
    await Promise.resolve()

    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)
    expect(upgrade).toHaveBeenCalled()

    socket.emit('data', Buffer.from([0x8a, 0x00]))
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(30_000)
    socket.emit('data', Buffer.from([0x8a, 0x00]))
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)

    socket.emit('data', Buffer.from('ls\n'))
    socket.emit('data', Buffer.from('top\n'))
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(30_000)
    socket.emit('data', Buffer.from([0x8a, 0x00]))
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)
  })

  it('stops refreshing when the client goes silent (dead or half-open peer)', async () => {
    const { service, boxService, socket } = buildUpgradeHarness()

    await service.upgrade(authRequest('blk_live_test'), socket as never, Buffer.alloc(0))
    await Promise.resolve()

    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)

    // A half-open TCP peer emits neither 'data' nor 'close' — the ledger must
    // go stale on silence alone, or a dead session defeats auto-stop.
    jest.advanceTimersByTime(10 * 60_000)
    await Promise.resolve()
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(1)
  })
})

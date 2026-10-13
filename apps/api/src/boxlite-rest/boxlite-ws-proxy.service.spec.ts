/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createProxyMiddleware } from 'http-proxy-middleware'
import type { IncomingMessage } from 'http'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'
import { AttachTicketService } from './attach-ticket.service'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => ({
    upgrade: jest.fn(),
  })),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

/** The two Redis calls `AttachTicketService` makes, over a map. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    set: async (key: string, value: string) => (store.set(key, value), 'OK'),
    getdel: async (key: string) => {
      const value = store.get(key) ?? null
      store.delete(key)
      return value
    },
  }
}

describe('BoxliteWsProxyService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
    const organizationService = {
      findOne: jest.fn().mockImplementation(async (id) => ({ id, suspended: false })),
    }
    const boxService = {
      findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1' }),
      updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    }
    const runnerService = {
      findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }),
    }
    const autoResume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
    const jwtStrategy = {
      verifyToken: jest.fn(),
    }
    const attachTickets = new AttachTicketService(fakeRedis() as never)
    const service = new BoxliteWsProxyService(
      apiKeyService as never,
      organizationUserService as never,
      organizationService as never,
      boxService as never,
      runnerService as never,
      autoResume as never,
      jwtStrategy as never,
      attachTickets,
    ) as unknown as {
      authenticate: (req: IncomingMessage, urlTenant?: string) => Promise<{ organization: { id: string } } | null>
    }

    return {
      service,
      apiKeyService,
      organizationUserService,
      organizationService,
      boxService,
      runnerService,
      autoResume,
      jwtStrategy,
      attachTickets,
    }
  }

  it('rewrites public box ids to internal box ids before proxying attach upgrades to the runner', () => {
    new BoxliteWsProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

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

  it('does not upgrade the websocket when strict AutoResume fails', async () => {
    const harness = buildAuthHarness()
    const { service, apiKeyService, organizationUserService, autoResume } = harness
    apiKeyService.getApiKeyByValue.mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      expiresAt: null,
    })
    organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
    harness.boxService.findOneByIdOrName.mockResolvedValue({
      id: 'box-uuid',
      runnerId: 'runner-1',
      autoResume: true,
    })
    autoResume.ensureReady.mockRejectedValue(new Error('start failed'))
    const socket = { write: jest.fn(), destroy: jest.fn() }
    const proxyHandler = jest.mocked(createProxyMiddleware).mock.results.at(-1)?.value

    await (service as unknown as BoxliteWsProxyService).upgrade(
      authRequest('blk_live_test'),
      socket as never,
      Buffer.alloc(0),
    )

    expect(autoResume.ensureReady).toHaveBeenCalledWith('box-uuid', expect.objectContaining({ id: 'org-1' }))
    expect(proxyHandler.upgrade).not.toHaveBeenCalled()
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('authenticates API key bearer tokens for websocket attach', async () => {
    const { service, apiKeyService, organizationUserService, jwtStrategy } = buildAuthHarness()
    apiKeyService.getApiKeyByValue.mockResolvedValue({
      organizationId: 'org-1',
      userId: 'user-1',
      expiresAt: null,
    })
    organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })

    await expect(service.authenticate(authRequest('blk_live_test'))).resolves.toEqual({
      organization: { id: 'org-1', suspended: false },
    })
    expect(organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'user-1')
    expect(jwtStrategy.verifyToken).not.toHaveBeenCalled()
  })

  it('authenticates JWT bearer tokens for websocket attach', async () => {
    const { service, organizationUserService, jwtStrategy } = buildAuthHarness()
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature'
    jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1', email: 'dev@acme.test' })
    organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })

    await expect(service.authenticate(authRequest(jwt), 'org-1')).resolves.toEqual({
      organization: { id: 'org-1', suspended: false },
    })
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

  describe('one-time attach tickets', () => {
    const attachUrl = (ticket: string, execId = 'exec-1') =>
      `/api/v1/org-1/boxes/public-box/executions/${execId}/attach?ticket=${ticket}&stdin=1`

    async function upgradeWithTicket(harness: ReturnType<typeof buildAuthHarness>, url: string) {
      const socket = { write: jest.fn(), destroy: jest.fn() }
      const req = { url, headers: {} } as IncomingMessage
      await (harness.service as unknown as BoxliteWsProxyService).upgrade(req, socket as never, Buffer.alloc(0))
      return { req, socket }
    }

    function ticketHarness() {
      const harness = buildAuthHarness()
      harness.organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'user-1' })
      return harness
    }

    const grant = { userId: 'user-1', organizationId: 'org-1', boxId: 'box-uuid', execId: 'exec-1' }

    it('accepts a ticket in place of a bearer and keeps it out of the runner request', async () => {
      const harness = ticketHarness()
      const proxyHandler = jest.mocked(createProxyMiddleware).mock.results.at(-1)?.value
      const ticket = await harness.attachTickets.issue(grant)

      const { req, socket } = await upgradeWithTicket(harness, attachUrl(ticket))

      expect(socket.write).not.toHaveBeenCalled()
      expect(proxyHandler.upgrade).toHaveBeenCalledTimes(1)
      expect(req.url).toBe('/api/v1/org-1/boxes/public-box/executions/exec-1/attach?stdin=1')
      expect(harness.organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'user-1')
    })

    it('refuses a ticket the second time', async () => {
      const harness = ticketHarness()
      const proxyHandler = jest.mocked(createProxyMiddleware).mock.results.at(-1)?.value
      const ticket = await harness.attachTickets.issue(grant)

      await upgradeWithTicket(harness, attachUrl(ticket))
      const { socket } = await upgradeWithTicket(harness, attachUrl(ticket))

      expect(proxyHandler.upgrade).toHaveBeenCalledTimes(1)
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'))
    })

    it.each([
      ['another execution', { ...grant, execId: 'exec-2' }],
      ['another box', { ...grant, boxId: 'other-box' }],
      ['another organization', { ...grant, organizationId: 'org-2' }],
    ])('refuses a ticket issued for %s', async (_case, issuedFor) => {
      const harness = ticketHarness()
      const proxyHandler = jest.mocked(createProxyMiddleware).mock.results.at(-1)?.value
      const ticket = await harness.attachTickets.issue(issuedFor)

      const { socket } = await upgradeWithTicket(harness, attachUrl(ticket))

      expect(proxyHandler.upgrade).not.toHaveBeenCalled()
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'))
    })

    it('refuses a ticket whose user has left the organization', async () => {
      const harness = buildAuthHarness()
      harness.organizationUserService.findOne.mockResolvedValue(null)
      const proxyHandler = jest.mocked(createProxyMiddleware).mock.results.at(-1)?.value
      const ticket = await harness.attachTickets.issue(grant)

      const { socket } = await upgradeWithTicket(harness, attachUrl(ticket))

      expect(proxyHandler.upgrade).not.toHaveBeenCalled()
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'))
    })
  })
})

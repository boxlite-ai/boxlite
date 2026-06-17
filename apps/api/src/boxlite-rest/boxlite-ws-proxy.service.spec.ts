/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { IncomingMessage } from 'http'
import { createProxyMiddleware } from 'http-proxy-middleware'
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

type AuthResult = { organizationId: string } | null
type ServiceInternals = {
  authenticate(req: IncomingMessage, urlTenant?: string): Promise<AuthResult>
}

function makeService() {
  const apiKeyService = { getApiKeyByValue: jest.fn() }
  const organizationUserService = { findOne: jest.fn() }
  const jwtStrategy = { verifyToken: jest.fn() }
  const service = new BoxliteWsProxyService(
    apiKeyService as never,
    organizationUserService as never,
    {} as never,
    {} as never,
    jwtStrategy as never,
  )
  return { service, apiKeyService, organizationUserService, jwtStrategy }
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage
const authenticate = (service: BoxliteWsProxyService, req: IncomingMessage, tenant?: string) =>
  (service as never as ServiceInternals).authenticate(req, tenant)

describe('BoxliteWsProxyService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

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

  describe('matchAttachPath', () => {
    it('captures the optional tenant (org id) and the box id', () => {
      const { service } = makeService()
      expect(service.matchAttachPath('/api/v1/acme/boxes/b1/executions/e1/attach')).toEqual({
        boxId: 'b1',
        tenant: 'acme',
      })
      expect(service.matchAttachPath('/api/v1/boxes/b1/executions/e1/attach')).toEqual({
        boxId: 'b1',
        tenant: undefined,
      })
      expect(service.matchAttachPath('/not/an/attach/path')).toBeNull()
    })
  })

  describe('authenticate', () => {
    it('authenticates a non-expired API key whose user is still a member (regression)', async () => {
      const { service, apiKeyService, organizationUserService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockResolvedValue({ organizationId: 'org-1', userId: 'u1', expiresAt: null })
      organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-1', userId: 'u1' })

      await expect(authenticate(service, bearer('apikey'), 'ignored-tenant')).resolves.toEqual({
        organizationId: 'org-1',
      })
      // API-key org wins; the URL tenant is ignored, and JWT is never consulted.
      expect(organizationUserService.findOne).toHaveBeenCalledWith('org-1', 'u1')
      expect(jwtStrategy.verifyToken).not.toHaveBeenCalled()
    })

    it('rejects an API key whose user is no longer a member of its org', async () => {
      const { service, apiKeyService, organizationUserService } = makeService()
      apiKeyService.getApiKeyByValue.mockResolvedValue({ organizationId: 'org-1', userId: 'u1', expiresAt: null })
      organizationUserService.findOne.mockResolvedValue(null)
      await expect(authenticate(service, bearer('apikey'))).resolves.toBeNull()
    })

    it('accepts a JWT whose user is a member of the URL tenant org', async () => {
      const { service, apiKeyService, organizationUserService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockRejectedValue(new Error('not an api key'))
      jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1' })
      organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-A', userId: 'user-1' })

      await expect(authenticate(service, bearer('jwt'), 'org-A')).resolves.toEqual({ organizationId: 'org-A' })
      expect(organizationUserService.findOne).toHaveBeenCalledWith('org-A', 'user-1')
    })

    it('rejects a JWT user who is not a member of the URL tenant org (cross-org boundary)', async () => {
      const { service, apiKeyService, organizationUserService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockRejectedValue(new Error('not an api key'))
      jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1' })
      organizationUserService.findOne.mockResolvedValue(null) // not a member of the requested org

      await expect(authenticate(service, bearer('jwt'), 'org-B')).resolves.toBeNull()
      // Membership is checked against the URL org, not any org the user belongs to.
      expect(organizationUserService.findOne).toHaveBeenCalledWith('org-B', 'user-1')
    })

    it('rejects a JWT with no tenant or the legacy `default` prefix (org ambiguous)', async () => {
      const { service, apiKeyService, organizationUserService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockRejectedValue(new Error('not an api key'))
      jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user-1' })

      await expect(authenticate(service, bearer('jwt'))).resolves.toBeNull()
      await expect(authenticate(service, bearer('jwt'), 'default')).resolves.toBeNull()
      expect(jwtStrategy.verifyToken).not.toHaveBeenCalled()
      expect(organizationUserService.findOne).not.toHaveBeenCalled()
    })

    it('rejects an invalid JWT (verifyToken throws)', async () => {
      const { service, apiKeyService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockRejectedValue(new Error('not an api key'))
      jwtStrategy.verifyToken.mockRejectedValue(new Error('bad signature'))
      await expect(authenticate(service, bearer('jwt'), 'org-A')).resolves.toBeNull()
    })

    it('rejects a JWT when no verifier is wired (skipConnections)', async () => {
      const apiKeyService = { getApiKeyByValue: jest.fn().mockRejectedValue(new Error('not an api key')) }
      const organizationUserService = { findOne: jest.fn() }
      const service = new BoxliteWsProxyService(
        apiKeyService as never,
        organizationUserService as never,
        {} as never,
        {} as never,
        undefined as never, // JwtStrategy provider resolves to undefined under skipConnections
      )
      await expect(authenticate(service, bearer('jwt'), 'org-A')).resolves.toBeNull()
    })

    it('uses the `uid` claim as the user id when `cid` is present (OKTA shape)', async () => {
      const { service, apiKeyService, organizationUserService, jwtStrategy } = makeService()
      apiKeyService.getApiKeyByValue.mockRejectedValue(new Error('not an api key'))
      jwtStrategy.verifyToken.mockResolvedValue({ sub: 'user@example.com', cid: 'client-1', uid: 'real-user-id' })
      organizationUserService.findOne.mockResolvedValue({ organizationId: 'org-A', userId: 'real-user-id' })

      await expect(authenticate(service, bearer('jwt'), 'org-A')).resolves.toEqual({ organizationId: 'org-A' })
      expect(organizationUserService.findOne).toHaveBeenCalledWith('org-A', 'real-user-id')
    })

    it('rejects a request with no bearer token', async () => {
      const { service } = makeService()
      await expect(authenticate(service, { headers: {} } as IncomingMessage, 'org-A')).resolves.toBeNull()
    })
  })
})

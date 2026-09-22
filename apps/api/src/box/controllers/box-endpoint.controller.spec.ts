/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { AddressInfo } from 'node:net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { BoxEndpointService } from '../services/box-endpoint.service'
import { BoxEndpointController } from './box-endpoint.controller'

describe('BoxEndpointController HTTP authorization and validation', () => {
  let app: INestApplication
  let user: Record<string, unknown>
  const endpoints = { bind: jest.fn(), list: jest.fn(), revoke: jest.fn(), resolve: jest.fn() }
  let base: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BoxEndpointController],
      providers: [
        { provide: BoxEndpointService, useValue: endpoints },
        { provide: OrganizationService, useValue: { findOne: async () => ({ id: 'org' }) } },
        {
          provide: OrganizationUserService,
          useValue: { findOne: async () => ({ role: 'member', assignedRoles: [] }) },
        },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { ...user }
          return Boolean(user)
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/box-endpoints`
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    user = {
      role: 'user',
      userId: 'user',
      organizationId: 'org',
      apiKey: { organizationId: 'org', permissions: ['write:boxes'] },
    }
    endpoints.bind.mockResolvedValue({ name: 'fleet' })
    endpoints.list.mockResolvedValue([])
    endpoints.resolve.mockResolvedValue({ name: 'fleet', boxId: 'AbCdEf123456', port: 8080 })
  })

  function put(name = 'fleet', port: unknown = 8080) {
    return fetch(`${base}/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxIdOrName: 'fleet', port }),
    })
  }

  it('binds within the authenticated organization', async () => {
    expect((await put()).status).toBe(200)
    expect(endpoints.bind).toHaveBeenCalledWith('org', 'fleet', { boxIdOrName: 'fleet', port: 8080 })
  })
  it.each([0, 65536, 22222, 1.5, '8080'])('rejects invalid port %s', async (port) => {
    expect((await put('fleet', port)).status).toBe(400)
    expect(endpoints.bind).not.toHaveBeenCalled()
  })
  it.each(['ab', 'Fleet', '-fleet', 'fleet-', 'a'.repeat(49)])('rejects invalid name %s', async (name) => {
    expect((await put(name)).status).toBe(400)
    expect(endpoints.bind).not.toHaveBeenCalled()
  })
  it('requires write:boxes to bind and revoke while allowing listing', async () => {
    user.apiKey = { organizationId: 'org', permissions: [] }
    expect((await put()).status).toBe(403)
    expect((await fetch(`${base}/fleet`, { method: 'DELETE' })).status).toBe(403)
    expect((await fetch(base)).status).toBe(200)
    expect(endpoints.revoke).not.toHaveBeenCalled()
  })
  it.each(['proxy', 'region-proxy', 'runner'])('rejects %s management requests', async (role) => {
    user = { role, regionId: 'west' }
    expect((await put()).status).toBe(403)
    expect((await fetch(base)).status).toBe(403)
    expect((await fetch(`${base}/fleet`, { method: 'DELETE' })).status).toBe(403)
  })
  it('allows revocation with write permission', async () => {
    expect((await fetch(`${base}/fleet`, { method: 'DELETE' })).status).toBe(204)
    expect(endpoints.revoke).toHaveBeenCalledWith('org', 'fleet')
  })
  it('restricts lookup to proxies and scopes a regional proxy', async () => {
    expect((await fetch(`${base}/resolve/fleet`)).status).toBe(401)
    user = { role: 'runner' }
    expect((await fetch(`${base}/resolve/fleet`)).status).toBe(401)
    user = { role: 'proxy' }
    const response = await fetch(`${base}/resolve/fleet`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(endpoints.resolve).toHaveBeenLastCalledWith('fleet', undefined)
    user = { role: 'region-proxy', regionId: 'west' }
    expect((await fetch(`${base}/resolve/fleet`)).status).toBe(200)
    expect(endpoints.resolve).toHaveBeenLastCalledWith('fleet', 'west')
  })
})

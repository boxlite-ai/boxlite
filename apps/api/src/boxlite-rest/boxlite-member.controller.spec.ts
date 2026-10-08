/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteMemberController } from './boxlite-member.controller'

// org-1 has an owner (user-1) and a plain member (user-3); user-2 belongs to org-2 only.
const memberships = new Map([
  ['org-1:user-1', { organizationId: 'org-1', userId: 'user-1', role: OrganizationMemberRole.OWNER }],
  ['org-1:user-3', { organizationId: 'org-1', userId: 'user-3', role: OrganizationMemberRole.MEMBER }],
  ['org-2:user-2', { organizationId: 'org-2', userId: 'user-2', role: OrganizationMemberRole.OWNER }],
])

// An API-key principal, as ApiKeyStrategy builds it: the key names its organization.
function apiKeyPrincipal(userId: string, organizationId: string) {
  return { userId, email: `${userId}@example.com`, role: SystemRole.USER, organizationId, apiKey: { organizationId } }
}

describe('BoxLite REST members', () => {
  let app: INestApplication
  let principal: ReturnType<typeof apiKeyPrincipal>
  const organizationUserService = {
    findOne: jest.fn(async (organizationId: string, userId: string) => memberships.get(`${organizationId}:${userId}`)),
    findAll: jest.fn(async () => [
      {
        userId: 'user-1',
        email: 'owner@example.com',
        name: 'Owner',
        role: OrganizationMemberRole.OWNER,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]),
    delete: jest.fn(async () => undefined),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteMemberController],
      providers: [
        OrganizationActionGuard,
        { provide: OrganizationUserService, useValue: organizationUserService },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { ...principal }
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0)
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  it("lets an owner's API key remove a member", async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('DELETE', '/v1/org-1/members/user-3')

    expect(response.status).toBe(204)
    expect(organizationUserService.delete).toHaveBeenCalledWith('org-1', 'user-3')
  })

  it('refuses member removal to a caller without the owner role', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('DELETE', '/v1/org-1/members/user-1')

    expect(response.status).toBe(403)
    expect(organizationUserService.delete).not.toHaveBeenCalled()
  })

  it("refuses an API key acting on another organization's members", async () => {
    principal = apiKeyPrincipal('user-2', 'org-2')

    const response = await call('DELETE', '/v1/org-1/members/user-3')

    expect(response.status).toBe(403)
    expect(organizationUserService.delete).not.toHaveBeenCalled()
  })

  it("lists the key's organization members on the canonical route", async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('GET', '/v1/members')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      members: [
        {
          user_id: 'user-1',
          email: 'owner@example.com',
          name: 'Owner',
          role: 'owner',
          joined_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    expect(organizationUserService.findAll).toHaveBeenCalledWith('org-1')
  })
})

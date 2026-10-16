/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type { AddressInfo } from 'net'
import { QueryFailedError } from 'typeorm'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationInvitationStatus } from '../organization/enums/organization-invitation-status.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteInvitationController } from './boxlite-invitation.controller'
import { BoxliteMemberController } from './boxlite-member.controller'

// org-1 has an owner (user-1) and a plain member (user-3); user-2 belongs to org-2 only.
const memberships = new Map([
  ['org-1:user-1', { organizationId: 'org-1', userId: 'user-1', role: OrganizationMemberRole.OWNER }],
  ['org-1:user-3', { organizationId: 'org-1', userId: 'user-3', role: OrganizationMemberRole.MEMBER }],
  ['org-2:user-2', { organizationId: 'org-2', userId: 'user-2', role: OrganizationMemberRole.OWNER }],
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// An API-key principal, as ApiKeyStrategy builds it: the key names its organization.
function apiKeyPrincipal(userId: string, organizationId: string) {
  return { userId, email: `${userId}@example.com`, role: SystemRole.USER, organizationId, apiKey: { organizationId } }
}

describe('BoxLite REST members and invitations', () => {
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
  const invitation = {
    id: 'inv-1',
    email: 'new@example.com',
    status: OrganizationInvitationStatus.PENDING,
    invitedBy: 'user-1@example.com',
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    expiresAt: new Date('2026-09-09T00:00:00.000Z'),
  }
  const organizationInvitationService = {
    create: jest.fn(async () => invitation),
    findPending: jest.fn(async () => [invitation]),
    // The invitation id column is a uuid, and Postgres answers any other string
    // with a cast error rather than a miss.
    cancel: jest.fn(async (_organizationId: string, invitationId: string) => {
      if (!UUID.test(invitationId)) {
        throw new QueryFailedError('SELECT', [invitationId], new Error('invalid input syntax for type uuid'))
      }
    }),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteMemberController, BoxliteInvitationController],
      providers: [
        OrganizationActionGuard,
        { provide: OrganizationUserService, useValue: organizationUserService },
        { provide: OrganizationInvitationService, useValue: organizationInvitationService },
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
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
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

  it('invites by email with the owner role and returns the pending invitation', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'new@example.com' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      id: 'inv-1',
      email: 'new@example.com',
      status: 'pending',
      invited_by: 'user-1@example.com',
      created_at: '2026-09-02T00:00:00.000Z',
      expires_at: '2026-09-09T00:00:00.000Z',
    })
    expect(organizationInvitationService.create).toHaveBeenCalledWith(
      'org-1',
      { email: 'new@example.com', role: OrganizationMemberRole.OWNER, assignedRoleIds: [], expiresAt: undefined },
      'user-1@example.com',
    )
  })

  it('passes a requested expiry to the service as a date', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', {
      email: 'new@example.com',
      expires_at: '2099-10-01T00:00:00.000Z',
    })

    expect(response.status).toBe(201)
    expect(organizationInvitationService.create).toHaveBeenCalledWith(
      'org-1',
      {
        email: 'new@example.com',
        role: OrganizationMemberRole.OWNER,
        assignedRoleIds: [],
        expiresAt: new Date('2099-10-01T00:00:00.000Z'),
      },
      'user-1@example.com',
    )
  })

  it('lists pending invitations to any member of the organization', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    const response = await call('GET', '/v1/org-1/invitations')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      invitations: [
        {
          id: 'inv-1',
          email: 'new@example.com',
          status: 'pending',
          invited_by: 'user-1@example.com',
          created_at: '2026-09-02T00:00:00.000Z',
          expires_at: '2026-09-09T00:00:00.000Z',
        },
      ],
    })
    expect(organizationInvitationService.findPending).toHaveBeenCalledWith('org-1')
  })

  it('rejects an invitation without a valid email before reaching the service', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'not-an-email' })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('refuses an invitation from a caller without the owner role', async () => {
    principal = apiKeyPrincipal('user-3', 'org-1')

    expect((await call('POST', '/v1/org-1/invitations', { email: 'new@example.com' })).status).toBe(403)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('lets an owner cancel a pending invitation, and refuses a plain member', async () => {
    const invitationId = '6f1c2a4e-0b7d-4c3e-9a5f-2d8e1b7c4a90'
    principal = apiKeyPrincipal('user-1', 'org-1')
    expect((await call('DELETE', `/v1/org-1/invitations/${invitationId}`)).status).toBe(204)
    expect(organizationInvitationService.cancel).toHaveBeenCalledWith('org-1', invitationId)

    principal = apiKeyPrincipal('user-3', 'org-1')
    expect((await call('DELETE', `/v1/org-1/invitations/${invitationId}`)).status).toBe(403)
    expect(organizationInvitationService.cancel).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for an invitation id that is not a UUID', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    expect((await call('DELETE', '/v1/org-1/invitations/not-a-uuid')).status).toBe(404)
  })

  it('rejects invitation fields the contract does not define', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', { email: 'new@example.com', role: 'member' })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })

  it('rejects an invitation that would already be expired', async () => {
    principal = apiKeyPrincipal('user-1', 'org-1')

    const response = await call('POST', '/v1/org-1/invitations', {
      email: 'new@example.com',
      expires_at: '2020-01-01T00:00:00.000Z',
    })

    expect(response.status).toBe(400)
    expect(organizationInvitationService.create).not.toHaveBeenCalled()
  })
})

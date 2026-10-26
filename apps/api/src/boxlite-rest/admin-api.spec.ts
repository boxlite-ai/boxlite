/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { HttpException, ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { parse } from 'yaml'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { OrganizationUserDto } from '../organization/dto/organization-user.dto'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationInvitationService } from '../organization/services/organization-invitation.service'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { User } from '../user/user.entity'
import { BoxliteInvitationController } from './boxlite-invitation.controller'
import { BoxliteMemberController } from './boxlite-member.controller'

const specRoot = resolve(__dirname, '../../../../openapi')
const specFile = 'admin.openapi.yaml'
const spec = parse(readFileSync(`${specRoot}/${specFile}`, 'utf8'))
const specId = 'https://contract.test/admin.openapi.yaml'
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
ajv.addSchema({ components: spec.components, paths: spec.paths }, specId)
ajv.addSchema(
  { components: parse(readFileSync(`${specRoot}/box.openapi.yaml`, 'utf8')).components },
  'https://contract.test/box.openapi.yaml',
)
const inviteId = '6f1c2a4e-0b7d-4c3e-9a5f-2d8e1b7c4a90'
const member = {
  userId: 'owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'owner',
  createdAt: new Date('2026-09-01Z'),
}
const invitation = {
  id: inviteId,
  email: 'new@example.com',
  role: 'owner',
  status: 'pending',
  invitedBy: 'owner@example.com',
  createdAt: new Date('2026-09-02Z'),
  expiresAt: new Date('2026-09-09Z'),
}
const operations = [
  { method: 'GET', path: '/organizations/users', status: 200, scope: 'read:members' },
  { method: 'GET', path: '/organizations/invites', status: 200, scope: 'read:members' },
  { method: 'POST', path: '/organizations/invites', status: 201, scope: 'write:members' },
  {
    method: 'DELETE',
    path: '/organizations/users/member',
    schema: '/organizations/users/{user_id}',
    status: 204,
    scope: 'write:members',
  },
  {
    method: 'DELETE',
    path: `/organizations/invites/${inviteId}`,
    schema: '/organizations/invites/{invite_id}',
    status: 204,
    scope: 'write:members',
  },
]

describe('Admin API HTTP contract', () => {
  let app: INestApplication
  let principal: any
  const members = {
    findOne: jest.fn(async (org: string, user: string) =>
      org === 'org-1' && ['owner', 'member'].includes(user) ? { role: user, organizationId: org, userId: user } : null,
    ),
    findPage: jest.fn(async () => [member]),
    findAll: jest.fn(async () => [member]),
    delete: jest.fn(),
  }
  const invites = {
    create: jest.fn(async () => invitation),
    findPage: jest.fn(async () => [invitation]),
    findPending: jest.fn(async () => [invitation]),
    cancel: jest.fn(),
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BoxliteMemberController, BoxliteInvitationController],
      providers: [
        OrganizationActionGuard,
        { provide: OrganizationUserService, useValue: members },
        { provide: OrganizationInvitationService, useValue: invites },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { ...principal }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0)
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(() => {
    jest.clearAllMocks()
    principal = {
      userId: 'owner',
      email: 'owner@example.com',
      role: 'user',
      organizationId: 'org-1',
      apiKey: { organizationId: 'org-1', permissions: ['read:members', 'write:members'] },
    }
  })
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  const payload = { email: 'new@example.com', role: 'owner' }
  async function success(response: Response, path: string, method: string, status: number) {
    expect(response.status).toBe(status)
    const contract = spec.paths[path]?.[method.toLowerCase()]?.responses[status]
    expect(contract).toBeDefined()
    if (status === 204) {
      expect(contract.content).toBeUndefined()
      expect(await response.text()).toBe('')
      return
    }
    const pointer = path.replace(/~/g, '~0').replace(/\//g, '~1')
    const validate = ajv.getSchema(
      `${specId}#/paths/${pointer}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`,
    )!
    const body = await response.json()
    expect(validate(body) ? [] : validate.errors).toEqual([])
    return body
  }
  it.each(operations)('serves $method $path with its declared scope and success schema', async (op) => {
    principal.apiKey.permissions = [op.scope]
    await success(
      await call(op.method, op.path, op.method === 'POST' ? payload : undefined),
      op.schema ?? op.path,
      op.method,
      op.status,
    )
  })
  it.each(operations)('keeps read and write independent on $method $path', async (op) => {
    principal.apiKey.permissions = [op.scope === 'read:members' ? 'write:members' : 'read:members']
    expect((await call(op.method, op.path, op.method === 'POST' ? payload : undefined)).status).toBe(403)
    expect(invites.create).not.toHaveBeenCalled()
    expect(members.delete).not.toHaveBeenCalled()
  })
  it.each([[], ['write:boxes'], ['read:tenant', 'write:tenant']])(
    'rejects keys with obsolete or unrelated scopes %j',
    async (...scopes) => {
      principal.apiKey.permissions = scopes
      expect((await call('GET', '/organizations/users')).status).toBe(403)
    },
  )
  it.each(operations)('retains owner JWT access on $method $path', async (op) => {
    delete principal.apiKey
    expect((await call(op.method, op.path, op.method === 'POST' ? payload : undefined)).status).toBe(op.status)
  })
  it.each(operations)('enforces membership role on $method $path', async (op) => {
    principal.userId = 'member'
    expect((await call(op.method, op.path, op.method === 'POST' ? payload : undefined)).status).toBe(
      op.method === 'GET' ? 200 : 403,
    )
  })
  it('cannot use a header to move a key into another organization', async () => {
    const response = await call('GET', '/organizations/users', undefined, { 'X-BoxLite-Organization-ID': 'org-2' })
    expect(response.status).toBe(200)
    expect(members.findPage).toHaveBeenCalledWith('org-1', 100, undefined)
  })
  it.each(['runner', 'proxy', 'health-check'])('refuses %s machine credentials', async (role) => {
    principal = { role }
    expect((await call('GET', '/organizations/users')).status).toBe(403)
  })
  it('bounds platform-admin keys by their delegated scopes', async () => {
    principal.role = 'admin'
    principal.apiKey.permissions = []
    expect((await call('GET', '/organizations/users')).status).toBe(403)
  })
  it.each(['/members', '/default/members', '/org-1/members', '/invitations', '/default/invitations'])(
    'removes obsolete route %s',
    async (path) => {
      delete principal.apiKey
      expect((await call('GET', path)).status).toBe(404)
    },
  )
  it.each(['missing email', 'missing user'])('normalizes %s in user responses', async (missing) => {
    const membership = Object.assign(new OrganizationUser(), { ...member, userId: 'owner', assignedRoles: [] })
    const user = missing === 'missing user' ? undefined : Object.assign(new User(), { name: 'Owner', email: '' })
    members.findPage.mockResolvedValueOnce([OrganizationUserDto.fromEntities(membership, user)])
    const body = await success(await call('GET', '/organizations/users'), '/organizations/users', 'GET', 200)
    expect(body.users[0]).toMatchObject({
      type: 'user',
      id: 'owner',
      email: null,
      added_at: member.createdAt.toISOString(),
    })
    expect(body.users[0]).not.toHaveProperty('user_id')
  })
  it('returns expired invites with role and stable resource fields', async () => {
    const body = await success(await call('GET', '/organizations/invites'), '/organizations/invites', 'GET', 200)
    expect(body.invites[0]).toEqual({
      type: 'invite',
      id: inviteId,
      email: invitation.email,
      role: 'owner',
      status: 'expired',
      added_at: invitation.createdAt.toISOString(),
      expires_at: invitation.expiresAt.toISOString(),
    })
  })
  it('returns the original creation status and forwards the idempotency key', async () => {
    const response = await call('POST', '/organizations/invites', payload, { 'Idempotency-Key': inviteId })
    const body = await success(response, '/organizations/invites', 'POST', 201)
    expect(body.status).toBe('pending')
    expect(invites.create).toHaveBeenCalledWith(
      'org-1',
      { email: payload.email, role: 'owner', assignedRoleIds: [], expiresAt: undefined },
      'owner@example.com',
      { userId: 'owner', idempotencyKey: inviteId },
    )
  })
  it.each([
    { email: 'a@example.com' },
    { ...payload, role: 'member' },
    { ...payload, extra: true },
    { ...payload, email: 'bad' },
    { ...payload, expires_at: null },
    { ...payload, expires_at: 'not-a-date' },
  ])('rejects invalid create request %j', async (body) => {
    expect((await call('POST', '/organizations/invites', body)).status).toBe(400)
    expect(invites.create).not.toHaveBeenCalled()
  })
  it('rejects invalid idempotency keys before invoking the service', async () => {
    expect((await call('POST', '/organizations/invites', payload, { 'Idempotency-Key': 'invalid' })).status).toBe(400)
    expect(invites.create).not.toHaveBeenCalled()
  })
  it.each(['0', '1001', '1.5', 'bad'])('rejects pageSize %s', async (size) => {
    expect((await call('GET', `/organizations/users?pageSize=${size}`)).status).toBe(400)
    expect(members.findPage).not.toHaveBeenCalled()
  })
  it('uses the next-page cursor and binds it to its organization and resource', async () => {
    members.findPage.mockResolvedValueOnce([member, { ...member, userId: 'user-2' }])
    const first = await success(
      await call('GET', '/organizations/users?pageSize=1'),
      '/organizations/users',
      'GET',
      200,
    )
    expect(first.users).toHaveLength(1)
    expect(first.next_page_token).toEqual(expect.any(String))
    const second = await success(
      await call('GET', `/organizations/users?pageSize=1&pageToken=${encodeURIComponent(first.next_page_token)}`),
      '/organizations/users',
      'GET',
      200,
    )
    expect(members.findPage).toHaveBeenLastCalledWith('org-1', 1, 'owner')
    expect(second).not.toHaveProperty('next_page_token')
    expect((await call('GET', `/organizations/invites?pageToken=${first.next_page_token}`)).status).toBe(400)
    principal.organizationId = 'org-2'
    principal.apiKey.organizationId = 'org-2'
    principal.role = 'admin'
    expect((await call('GET', `/organizations/users?pageToken=${first.next_page_token}`)).status).toBe(400)
  })
  it.each(['%%%', '', 'e30'])('rejects malformed pageToken %s', async (token) => {
    expect((await call('GET', `/organizations/invites?pageToken=${encodeURIComponent(token)}`)).status).toBe(400)
    expect(invites.findPage).not.toHaveBeenCalled()
  })
  it.each([400, 401, 403, 404, 409, 422, 429, 500, 503])('uses the shared Box error schema for %s', async (status) => {
    members.findPage.mockRejectedValueOnce(new HttpException('Request refused', status))
    const response = await call('GET', '/organizations/users')
    expect(response.status).toBe(status)
    const body = await response.json()
    const validate = ajv.getSchema('https://contract.test/box.openapi.yaml#/components/schemas/ErrorResponse')!
    expect(validate(body) ? [] : validate.errors).toEqual([])
    expect(body.error.message).toBe('Request refused')
  })
})

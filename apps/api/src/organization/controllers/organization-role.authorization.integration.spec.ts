/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import axios from 'axios'
import { DataSource, Repository } from 'typeorm'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { SystemRole } from '../../user/enums/system-role.enum'
import { Organization } from '../entities/organization.entity'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../guards/organization-resource-action.guard'
import { OrganizationRoleService } from '../services/organization-role.service'
import { OrganizationService } from '../services/organization.service'
import { OrganizationUserService } from '../services/organization-user.service'
import { OrganizationRoleController } from './organization-role.controller'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `org_role_${randomUUID().replaceAll('-', '')}`
const initial = { name: 'Custom role', description: 'Role authorization test', permissions: [Permission.WRITE_BOXES] }
const changed = { ...initial, name: 'Updated role', permissions: [Permission.DELETE_BOXES] }

describeWithDatabase('Organization role authorization (HTTP and Postgres)', () => {
  let app: INestApplication
  let db: DataSource
  let organizations: Repository<Organization>
  let roles: Repository<OrganizationRole>
  let memberships: Repository<OrganizationUser>
  let roleService: OrganizationRoleService
  let userService: OrganizationUserService
  let orgA: Organization
  let orgB: Organization
  let roleA: OrganizationRole
  let roleB: OrganizationRole
  let globalRole: OrganizationRole

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('Organization role tests require a disposable loopback PostgreSQL database')
    }
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser],
      namingStrategy: new CustomNamingStrategy(),
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    organizations = db.getRepository(Organization)
    roles = db.getRepository(OrganizationRole)
    memberships = db.getRepository(OrganizationUser)
    roleService = new OrganizationRoleService(roles)
    const redis = { get: async () => null, set: async () => 'OK' }
    userService = new OrganizationUserService(memberships, roleService, {} as never, {} as never, db, redis as never)
    const organizationService = new OrganizationService(
      organizations,
      {} as never,
      {} as never,
      { getOrThrow: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationRoleController],
      providers: [
        { provide: OrganizationRoleService, useValue: roleService },
        // Exercise the production lookup without starting unrelated background organization jobs.
        { provide: OrganizationService, useValue: { findOne: organizationService.findOne.bind(organizationService) } },
        { provide: OrganizationUserService, useValue: userService },
        { provide: getRedisConnectionToken(), useValue: redis },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest()
          req.user = {
            userId: req.headers['x-test-user'] || 'owner-a',
            email: 'test@example.com',
            role: SystemRole.USER,
          }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    try {
      await app?.close()
    } finally {
      if (db?.isInitialized) {
        try {
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        } finally {
          await db.destroy()
        }
      }
    }
  })

  beforeEach(async () => {
    await db.query(`TRUNCATE "${schema}".organization, "${schema}".organization_role CASCADE`)
    orgA = await organizations.save({ name: 'Organization A', createdBy: 'owner-a' })
    orgB = await organizations.save({ name: 'Organization B', createdBy: 'owner-b' })
    roleA = await roleService.create(orgA.id, initial)
    roleB = await roleService.create(orgB.id, initial)
    globalRole = await roles.save({ ...initial, name: 'Global role', isGlobal: true })
    await memberships.save([
      { organizationId: orgA.id, userId: 'owner-a', role: OrganizationMemberRole.OWNER },
      { organizationId: orgA.id, userId: 'member-a', role: OrganizationMemberRole.MEMBER },
      { organizationId: orgB.id, userId: 'owner-b', role: OrganizationMemberRole.OWNER },
    ])
  })

  function path(roleId?: string) {
    return `/api/organizations/${orgA.id}/roles${roleId ? `/${roleId}` : ''}`
  }

  async function call(method: string, roleId?: string, data?: unknown, userId = 'owner-a') {
    return axios.request({
      baseURL: await app.getUrl(),
      url: path(roleId),
      method,
      data,
      headers: { 'x-test-user': userId },
      validateStatus: () => true,
    })
  }

  it.each(['get', 'post', 'put', 'delete'] as const)('denies a member on %s without changing roles', async (method) => {
    const before = await roles.find({ order: { id: 'ASC' } })
    const response = await call(
      method,
      method === 'put' || method === 'delete' ? roleA.id : undefined,
      method === 'post' || method === 'put' ? changed : undefined,
      'member-a',
    )

    expect(response.status).toBe(403)
    expect(await roles.find({ order: { id: 'ASC' } })).toEqual(before)
  })

  it.each(['put', 'delete'] as const)('denies an owner using a foreign custom role on %s', async (method) => {
    const before = await roles.findOneByOrFail({ id: roleB.id })
    const response = await call(method, roleB.id, method === 'put' ? changed : undefined)

    expect(response.status).toBe(404)
    expect(await roles.findOneBy({ id: roleB.id })).toEqual(before)
  })

  it.each(['put', 'delete'] as const)('keeps global roles immutable on %s', async (method) => {
    const before = await roles.findOneByOrFail({ id: globalRole.id })
    const response = await call(method, globalRole.id, method === 'put' ? changed : undefined)

    expect(response.status).toBe(403)
    expect(await roles.findOneBy({ id: globalRole.id })).toEqual(before)
  })

  it.each(['put', 'delete'] as const)(
    'returns 404 for an unknown role on %s despite an unrelated global role',
    async (method) => {
      const before = await roles.find({ order: { id: 'ASC' } })
      const response = await call(method, randomUUID(), method === 'put' ? changed : undefined)
      expect(response.status).toBe(404)
      expect(await roles.find({ order: { id: 'ASC' } })).toEqual(before)
    },
  )

  it('allows an owner to create, list, update and delete roles in their organization', async () => {
    const created = await call('post', undefined, initial)
    expect(created.status).toBe(201)
    expect(await roles.findOneBy({ id: created.data.id })).toMatchObject({ organizationId: orgA.id, ...initial })
    const listed = await call('get')
    expect(listed.status).toBe(200)
    expect(listed.data.map((role: OrganizationRole) => role.id).sort()).toEqual(
      [created.data.id, roleA.id, globalRole.id].sort(),
    )
    expect((await call('put', created.data.id, changed)).status).toBe(200)
    expect(await roles.findOneBy({ id: created.data.id })).toMatchObject({ organizationId: orgA.id, ...changed })
    expect((await call('delete', created.data.id)).status).toBe(200)
    expect(await roles.findOneBy({ id: created.data.id })).toBeNull()
    expect(await roles.findOneBy({ id: roleB.id })).toMatchObject({ organizationId: orgB.id, ...initial })
  })

  it('uses updated role permissions when an assigned membership is reloaded', async () => {
    await memberships.save({ organizationId: orgA.id, userId: 'member-a', assignedRoles: [roleA] })
    const before = await userService.findOne(orgA.id, 'member-a')
    if (!before) throw new Error('Assigned membership must exist before the role update')
    expect(
      hasOrganizationResourcePermissions({ role: SystemRole.USER, organizationUser: before }, [
        Permission.DELETE_BOXES,
      ]),
    ).toBe(false)

    expect((await call('put', roleA.id, changed)).status).toBe(200)

    const after = await userService.findOne(orgA.id, 'member-a')
    if (!after) throw new Error('Assigned membership must exist after the role update')
    expect(
      hasOrganizationResourcePermissions({ role: SystemRole.USER, organizationUser: after }, [Permission.DELETE_BOXES]),
    ).toBe(true)
    expect(
      hasOrganizationResourcePermissions({ role: SystemRole.USER, organizationUser: after }, [Permission.WRITE_BOXES]),
    ).toBe(false)
  })

  describe.each(['update', 'delete'] as const)('%s identifiers', (operation) => {
    it.each([
      ['organization', undefined],
      ['organization', null],
      ['role', undefined],
      ['role', null],
    ] as const)('rejects a missing %s identifier (%s) before mutation', async (field, missing) => {
      const before = await roles.find({ order: { id: 'ASC' } })
      const organizationId = field === 'organization' ? (missing as unknown as string) : orgA.id
      const roleId = field === 'role' ? (missing as unknown as string) : roleA.id
      const controller = app.get(OrganizationRoleController)

      const result =
        operation === 'update'
          ? controller.updateRole(organizationId, roleId, changed)
          : controller.delete(organizationId, roleId)
      await expect(result).rejects.toMatchObject({ status: 404 })
      expect(await roles.find({ order: { id: 'ASC' } })).toEqual(before)
    })
  })
})

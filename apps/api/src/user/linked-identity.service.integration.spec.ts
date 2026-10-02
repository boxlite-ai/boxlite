/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { ApiKey } from '../api-key/api-key.entity'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { LinkedIdentityService } from './linked-identity.service'
import { User } from './user.entity'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `linked_identity_${process.pid}_${randomUUID().replaceAll('-', '')}`

const PRIMARY = 'auth0|primary'
const SOCIAL = 'google-oauth2|103'

describeIfDatabase('LinkedIdentityService.adopt (integration, real Postgres)', () => {
  let dataSource: DataSource
  let service: LinkedIdentityService

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [User, Organization, OrganizationInvitation, OrganizationRole, OrganizationUser, ApiKey],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    service = new LinkedIdentityService(dataSource)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    for (const table of ['api_key', 'organization_role_assignment', 'organization_user', 'organization_role']) {
      await dataSource.query(`DELETE FROM "${table}"`)
    }
    await dataSource.query(`DELETE FROM "organization"`)
    await dataSource.query(`DELETE FROM "user"`)
  })

  async function user(id: string, name = id) {
    await dataSource.getRepository(User).insert({
      id,
      name,
      email: 'ada@example.com',
      emailVerified: true,
      publicKeys: [],
    })
  }

  async function organization(createdBy: string, name: string): Promise<string> {
    const saved = await dataSource.getRepository(Organization).save({ name, createdBy })
    return saved.id
  }

  async function member(organizationId: string, userId: string, role: OrganizationMemberRole, isDefault: boolean) {
    await dataSource.getRepository(OrganizationUser).insert({
      organizationId,
      userId,
      role,
      isDefaultForUser: isDefault,
    })
  }

  async function role(organizationId: string, name: string): Promise<string> {
    const saved = await dataSource.getRepository(OrganizationRole).save({
      name,
      description: name,
      permissions: [],
      organizationId,
    })
    return saved.id
  }

  async function assign(organizationId: string, userId: string, roleId: string) {
    await dataSource.query(
      `INSERT INTO "organization_role_assignment" ("organizationId", "userId", "roleId") VALUES ($1, $2, $3)`,
      [organizationId, userId, roleId],
    )
  }

  async function apiKey(organizationId: string, userId: string, name: string) {
    await dataSource.getRepository(ApiKey).insert({
      organizationId,
      userId,
      name,
      keyHash: randomUUID(),
      permissions: [],
      createdAt: new Date(),
    })
  }

  function membershipsOf(userId: string): Promise<OrganizationUser[]> {
    return dataSource.getRepository(OrganizationUser).find({ where: { userId }, order: { createdAt: 'ASC' } })
  }

  async function assignmentsOf(userId: string): Promise<string[]> {
    const rows: { roleId: string }[] = await dataSource.query(
      `SELECT "roleId" FROM "organization_role_assignment" WHERE "userId" = $1 ORDER BY "roleId"`,
      [userId],
    )
    return rows.map((row) => row.roleId)
  }

  it('does nothing for a social identity BoxLite never saw', async () => {
    await user(PRIMARY)

    await service.adopt(PRIMARY, SOCIAL)

    expect(await dataSource.getRepository(User).count()).toBe(1)
  })

  it('gives a brand-new primary the social account and its organization as the only default', async () => {
    await user(SOCIAL, 'Ada Lovelace')
    const org = await organization(SOCIAL, 'Ada’s organization')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)
    await apiKey(org, SOCIAL, 'ci')

    await service.adopt(PRIMARY, SOCIAL)

    const primary = await dataSource.getRepository(User).findOneByOrFail({ id: PRIMARY })
    expect(primary).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: true })
    // The requirement for a first-time social login: exactly one organization,
    // and it is the one the person has been using.
    expect(await membershipsOf(PRIMARY)).toEqual([
      expect.objectContaining({ organizationId: org, role: OrganizationMemberRole.OWNER, isDefaultForUser: true }),
    ])
    expect(await dataSource.getRepository(Organization).count()).toBe(1)
    expect(await dataSource.getRepository(ApiKey).findOneByOrFail({ name: 'ci' })).toMatchObject({ userId: PRIMARY })
    expect(await dataSource.getRepository(Organization).findOneByOrFail({ id: org })).toMatchObject({
      createdBy: PRIMARY,
    })
  })

  it('keeps an existing primary’s default and adds the social organization beside it', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const own = await organization(PRIMARY, 'password org')
    const social = await organization(SOCIAL, 'social org')
    await member(own, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(social, SOCIAL, OrganizationMemberRole.OWNER, true)

    await service.adopt(PRIMARY, SOCIAL)

    const memberships = await membershipsOf(PRIMARY)
    expect(memberships).toHaveLength(2)
    expect(memberships.filter((row) => row.isDefaultForUser).map((row) => row.organizationId)).toEqual([own])
    expect(memberships.find((row) => row.organizationId === social)).toMatchObject({
      role: OrganizationMemberRole.OWNER,
      isDefaultForUser: false,
    })
    expect(await membershipsOf(SOCIAL)).toEqual([])
  })

  it('merges a shared organization into one membership, keeping the stronger role and every assignment', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(SOCIAL, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.MEMBER, false)
    await member(shared, SOCIAL, OrganizationMemberRole.OWNER, false)
    const viewer = await role(shared, 'viewer')
    const deployer = await role(shared, 'deployer')
    await assign(shared, PRIMARY, viewer)
    await assign(shared, SOCIAL, viewer)
    await assign(shared, SOCIAL, deployer)

    await service.adopt(PRIMARY, SOCIAL)

    expect(await membershipsOf(PRIMARY)).toEqual([
      expect.objectContaining({ organizationId: shared, role: OrganizationMemberRole.OWNER }),
    ])
    expect(await assignmentsOf(PRIMARY)).toEqual([viewer, deployer].sort())
    expect(await assignmentsOf(SOCIAL)).toEqual([])
  })

  it('keeps both keys when the two accounts named one the same in a shared organization', async () => {
    await user(PRIMARY)
    await user(SOCIAL)
    const shared = await organization(PRIMARY, 'shared')
    await member(shared, PRIMARY, OrganizationMemberRole.OWNER, true)
    await member(shared, SOCIAL, OrganizationMemberRole.MEMBER, true)
    await apiKey(shared, PRIMARY, 'ci')
    await apiKey(shared, SOCIAL, 'ci')

    await service.adopt(PRIMARY, SOCIAL)

    const names = (await dataSource.getRepository(ApiKey).find({ where: { userId: PRIMARY } })).map((key) => key.name)
    expect(names.sort()).toEqual(['ci', 'ci (google-oauth2)'])
  })

  it('moves nothing the second time', async () => {
    await user(SOCIAL)
    const org = await organization(SOCIAL, 'social org')
    await member(org, SOCIAL, OrganizationMemberRole.OWNER, true)

    await service.adopt(PRIMARY, SOCIAL)
    await service.adopt(PRIMARY, SOCIAL)

    expect(await membershipsOf(PRIMARY)).toHaveLength(1)
  })
})

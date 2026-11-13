/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { ForbiddenException } from '@nestjs/common'
import { DataSource, Repository } from 'typeorm'
import { Domain } from '../../box/entities/domain.entity'
import { DomainService } from '../../box/services/domain.service'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { UserDeletedEvent } from '../../user/events/user-deleted.event'
import { Organization } from '../entities/organization.entity'
import { OrganizationInvitation } from '../entities/organization-invitation.entity'
import { OrganizationRole } from '../entities/organization-role.entity'
import { OrganizationUser } from '../entities/organization-user.entity'
import { OrganizationService } from './organization.service'
import { AddCustomDomainConfig1793764800000 } from '../../migrations/pre-deploy/1793764800000-add-custom-domain-config-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `org_domain_${process.pid}_${randomUUID().replaceAll('-', '')}`

describeIfDatabase('organization domain lifecycle (real Postgres)', () => {
  let dataSource: DataSource
  let organizations: Repository<Organization>
  let service: OrganizationService
  let domains: DomainService
  let organization: Organization

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser, Domain],
      namingStrategy: new CustomNamingStrategy(),
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()
    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    const runner = dataSource.createQueryRunner()
    try {
      await new AddCustomDomainConfig1793764800000().up(runner)
    } finally {
      await runner.release()
    }
    await dataSource.query(
      `CREATE TABLE "${schemaName}".deletion_blocker (organization_id uuid REFERENCES "${schemaName}".organization(id))`,
    )
    organizations = dataSource.getRepository(Organization)
    service = new OrganizationService(
      organizations,
      {} as never,
      { emitAsync: jest.fn() } as never,
      { getOrThrow: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
    )
    domains = new DomainService(
      dataSource,
      {} as never,
      {
        get: () => 'app.test',
        getOrThrow: (key: string) => (key === 'domain.platformSubdomainMinLength' ? 5 : 'https'),
      } as never,
      {} as never,
    )
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
    await dataSource.query(`TRUNCATE custom_domain_config`)
    await dataSource.query(`DELETE FROM "${schemaName}".deletion_blocker`)
    await dataSource.getRepository(Domain).clear()
    await organizations.query(`DELETE FROM "${schemaName}".organization`)
    organization = await organizations.save({ name: 'Domain owner', createdBy: 'test-user' })
  })

  it('releases a deleted organization’s names so another organization can claim them', async () => {
    const held = await domains.claim(organization.id, 'released')
    await service.delete(organization.id)
    expect(await dataSource.getRepository(Domain).find()).toEqual([])
    const next = await organizations.save({ name: 'Next owner', createdBy: 'next-user' })
    await expect(domains.claim(next.id, 'released')).resolves.toMatchObject({ hostname: held.hostname })
  })

  it('preserves names when the organization is a user’s default', async () => {
    const held = await domains.claim(organization.id, 'retained')
    await dataSource
      .getRepository(OrganizationUser)
      .save({ organizationId: organization.id, userId: 'test-user', isDefaultForUser: true })
    await expect(service.delete(organization.id)).rejects.toBeInstanceOf(ForbiddenException)
    expect(await dataSource.getRepository(Domain).findOneByOrFail({ hostname: held.hostname })).toMatchObject({
      organizationId: organization.id,
    })
  })

  it('also releases names when deleting the sole user removes their default organization', async () => {
    await domains.claim(organization.id, 'removed-user')
    await dataSource.getRepository(OrganizationUser).save({
      organizationId: organization.id,
      userId: 'test-user',
      isDefaultForUser: true,
    })
    await dataSource.transaction((manager) =>
      service.handleUserDeletedEvent(new UserDeletedEvent(manager, 'test-user')),
    )
    expect(await organizations.existsBy({ id: organization.id })).toBe(false)
    expect(await dataSource.getRepository(Domain).find()).toEqual([])
  })

  it('rolls domain cleanup back when organization removal fails', async () => {
    const held = await domains.claim(organization.id, 'rollback')
    await dataSource.query(`INSERT INTO "${schemaName}".deletion_blocker VALUES ($1)`, [organization.id])
    await expect(service.delete(organization.id)).rejects.toThrow()
    expect(await dataSource.getRepository(Domain).findOneByOrFail({ hostname: held.hostname })).toMatchObject({
      organizationId: organization.id,
    })
    expect(await organizations.existsBy({ id: organization.id })).toBe(true)
  })

  it('keeps durable cloud cleanup ownership after organization deletion and rolls it back on failure', async () => {
    await dataSource.query(
      `INSERT INTO custom_domain_config (organization_id, hostname, challenge, challenge_expires_at, provider_state)
      VALUES ($1, 'app.customer.com', 'proof', now() + interval '1 day', '{"certificate":"owned-resource"}')`,
      [organization.id],
    )
    await dataSource.query(`INSERT INTO "${schemaName}".deletion_blocker VALUES ($1)`, [organization.id])
    await expect(service.delete(organization.id)).rejects.toThrow()
    expect((await dataSource.query(`SELECT deleted_at FROM custom_domain_config`))[0].deleted_at).toBeNull()
    await dataSource.query(`DELETE FROM "${schemaName}".deletion_blocker`)
    await service.delete(organization.id)
    const [row] = await dataSource.query(`SELECT phase, provider_state, deleted_at FROM custom_domain_config`)
    expect(row).toMatchObject({ phase: 'deleting', provider_state: { certificate: 'owned-resource' } })
    expect(row.deleted_at).not.toBeNull()
  })
})

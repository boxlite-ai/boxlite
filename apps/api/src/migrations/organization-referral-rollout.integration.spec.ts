import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { globSync } from 'glob'
import { DataSource } from 'typeorm'
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions'
import { OrganizationInvitation } from '../organization/entities/organization-invitation.entity'
import { OrganizationRole } from '../organization/entities/organization-role.entity'
import { OrganizationUser } from '../organization/entities/organization-user.entity'
import { Organization } from '../organization/entities/organization.entity'
import appDataSource from './data-source'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip

describeWithDatabase('organization referral-code rollout', () => {
  const database = `org_referral_${randomUUID().replaceAll('-', '')}`
  const options = appDataSource.options as PostgresConnectionOptions
  const admin = new DataSource({ ...options, entities: [], migrations: [] })
  const connection = { ...options, database, migrationsRun: true }
  const id = randomUUID()

  beforeAll(async () => {
    await admin.initialize()
    await admin.query(`CREATE DATABASE "${database}"`)
  })

  afterAll(async () => {
    if (!admin.isInitialized) return
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`)
    } finally {
      await admin.destroy()
    }
  })

  it('preserves existing referral codes for older API instances across startup and organization writes', async () => {
    const referralExpansion = '1789500000000-add-organization-referral-migration.ts'
    const releasedMigrations = globSync(join(__dirname, '**/*-migration.ts')).filter(
      (file) => basename(file) <= referralExpansion,
    )
    const previous = await new DataSource({ ...connection, entities: [], migrations: releasedMigrations }).initialize()
    try {
      await previous.query('INSERT INTO organization (id, name, "createdBy", "referralCode") VALUES ($1, $2, $3, $4)', [
        id,
        'Existing organization',
        'owner',
        'ABCD2345EF',
      ])
    } finally {
      await previous.destroy()
    }

    const current = await new DataSource({
      ...connection,
      entities: [Organization, OrganizationInvitation, OrganizationRole, OrganizationUser],
    }).initialize()
    try {
      const organizations = current.getRepository(Organization)
      const existing = await organizations.findOneByOrFail({ id })
      expect(existing).not.toHaveProperty('referralCode')
      await organizations.save({ ...existing, name: 'Renamed organization' })
      const created = await organizations.save({ name: 'New organization', createdBy: 'owner' })

      const readFromPreviousAPI = 'SELECT "referralCode" FROM organization WHERE id = $1'
      expect(await current.query(readFromPreviousAPI, [id])).toEqual([{ referralCode: 'ABCD2345EF' }])
      expect(await current.query(readFromPreviousAPI, [created.id])).toEqual([{ referralCode: null }])
      await expect(
        current.query('UPDATE organization SET "referralCode" = $1 WHERE id = $2', ['ABCD2345EF', created.id]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'organization_referral_code_uq' })
    } finally {
      await current.destroy()
    }
  }, 120_000)
})

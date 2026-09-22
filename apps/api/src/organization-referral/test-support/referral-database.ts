import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DataSource, DataSourceOptions, MigrationInterface } from 'typeorm'
import { User } from '../../user/user.entity'
import { ApiKey } from '../../api-key/api-key.entity'
import { UserRegistration } from '../../user/user-registration.entity'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { OrganizationRole } from '../../organization/entities/organization-role.entity'
import { OrganizationInvitation } from '../../organization/entities/organization-invitation.entity'
import { Region } from '../../region/entities/region.entity'
import { BusinessEventOutbox } from '../../business-events/business-event-outbox.entity'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'

type MigrationClass = new () => MigrationInterface

/** Fresh databases only. The configured shared database is never opened for test DDL/DML. */
export class ReferralDatabase {
  readonly name = 'boxlite_referral_' + randomUUID().replace(/-/g, '')
  private admin: DataSource
  private readonly connections: DataSource[] = []
  private created = false

  async initialize(): Promise<DataSource> {
    for (const key of ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD']) {
      if (!process.env[key]) throw new Error('Referral integration requires ' + key)
    }
    this.admin = new DataSource({ ...this.options(), database: 'postgres' } as DataSourceOptions)
    await this.admin.initialize()
    try {
      await this.admin.query('CREATE DATABASE "' + this.name + '"')
      this.created = true
      const directory = join(__dirname, '../../migrations')
      const paths = (await readdir(directory, { recursive: true }))
        .filter((file) => file.endsWith('-migration.ts'))
        .sort()
      const migrations = paths.flatMap((file) => Object.values(require(join(directory, file)))) as MigrationClass[]
      const database = await this.connect('migrations', migrations)
      await database.runMigrations({ transaction: 'all' })
      return database
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async connect(instance: string, migrations: MigrationClass[] = []): Promise<DataSource> {
    if (!this.created) throw new Error('Disposable database has not been created')
    const database = new DataSource({
      ...this.options(),
      database: this.name,
      migrations,
      entities: [
        User,
        ApiKey,
        UserRegistration,
        Organization,
        OrganizationUser,
        OrganizationRole,
        OrganizationInvitation,
        Region,
        BusinessEventOutbox,
      ],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { max: 30, application_name: this.name + '_' + instance, connectionTimeoutMillis: 10_000 },
    } as DataSourceOptions)
    await database.initialize()
    this.connections.push(database)
    return database
  }

  async close(): Promise<void> {
    for (const database of this.connections.splice(0)) if (database.isInitialized) await database.destroy()
    if (this.created && this.admin?.isInitialized) {
      await this.admin.query('DROP DATABASE "' + this.name + '"')
      this.created = false
    }
    if (this.admin?.isInitialized) await this.admin.destroy()
  }

  private options(): DataSourceOptions {
    return {
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      ssl:
        process.env.DB_TLS_ENABLED === 'true'
          ? { rejectUnauthorized: process.env.DB_TLS_REJECT_UNAUTHORIZED !== 'false' }
          : false,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      extra: { connectionTimeoutMillis: 10_000 },
    }
  }
}

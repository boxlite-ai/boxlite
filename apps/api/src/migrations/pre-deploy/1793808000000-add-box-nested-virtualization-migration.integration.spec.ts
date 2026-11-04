import { randomUUID } from 'node:crypto'
import { DataSource, QueryRunner } from 'typeorm'
import { AddBoxNestedVirtualization1793808000000 } from './1793808000000-add-box-nested-virtualization-migration'
import { Box } from '../../box/entities/box.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxMigration } from '../../box/entities/box-migration.entity'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BoxService } from '../../box/services/box.service'
import { BoxDto } from '../../box/dto/box.dto'
import { Context } from '../../common/context/context'
import { boxToBoxResponse, createBoxToCreateBox } from '../../boxlite-rest/mappers/box-to-box.mapper'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const suffix = randomUUID().replaceAll('-', '')
const migrationSchema = `nested_migration_${suffix}`
const databaseName = `nested_persistence_${suffix}`
const connection = {
  type: 'postgres' as const,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
}

describeDatabase('Cloud nested virtualization persistence (real Postgres)', () => {
  let admin: DataSource
  let entities: DataSource
  let query: QueryRunner
  let ownsDatabase = false
  const migration = new AddBoxNestedVirtualization1793808000000()

  beforeAll(async () => {
    const bootstrap = await new DataSource({ ...connection, entities: [] }).initialize()
    try {
      await bootstrap.query(`CREATE DATABASE "${databaseName}"`)
      ownsDatabase = true
    } finally {
      await bootstrap.destroy()
    }
    admin = await new DataSource({ ...connection, database: databaseName, entities: [] }).initialize()
    await admin.query(`CREATE SCHEMA "${migrationSchema}"`)
    query = admin.createQueryRunner()
    await query.connect()
    await query.query(`SET search_path TO "${migrationSchema}"`)
    await query.query('CREATE TABLE "box" (id varchar PRIMARY KEY)')
    await query.query('INSERT INTO "box" (id) VALUES ($1)', ['legacy'])
    entities = await new DataSource({
      ...connection,
      database: databaseName,
      entities: [Box, Runner, BoxLastActivity, BoxMigration],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
    }).initialize()
    await entities.synchronize()
  })

  afterAll(async () => {
    await query?.release()
    if (entities?.isInitialized) await entities.destroy()
    if (admin?.isInitialized) {
      await admin.destroy()
    }
    if (ownsDatabase) {
      const bootstrap = await new DataSource({ ...connection, entities: [] }).initialize()
      try {
        await bootstrap.query(`DROP DATABASE "${databaseName}"`)
      } finally {
        await bootstrap.destroy()
      }
    }
  })

  it('preserves legacy unknown, refuses destructive down with true, and reverses safely', async () => {
    await migration.up(query)
    const [legacy] = await query.query('SELECT "nestedVirtualization" FROM "box" WHERE id=$1', ['legacy'])
    expect(legacy.nestedVirtualization).toBeNull()
    const legacyBox = Object.assign(new Box('local', 'legacy'), legacy)
    expect(boxToBoxResponse(BoxDto.fromBox(legacyBox, '')).advanced).toBeUndefined()
    await query.query('INSERT INTO "box" (id,"nestedVirtualization") VALUES ($1,$2)', ['nested', true])
    await expect(migration.down(query)).rejects.toThrow('Retire nested boxes')
    await query.query('DELETE FROM "box" WHERE id=$1', ['nested'])
    await migration.down(query)
    const columns = await query.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
      [migrationSchema, 'box'],
    )
    expect(columns.map((column) => column.column_name)).toEqual(['id'])
  })

  it.each([false, true])(
    'saves a production create requirement %j and projects it after ORM reload',
    async (required) => {
      const repository = entities.getRepository(Box)
      const service = Object.create(BoxService.prototype) as BoxService
      Object.assign(service, {
        getValidatedOrDefaultRegion: async () => ({ id: 'local' }),
        getValidatedOrDefaultClass: () => 'small',
        configService: { get: () => true },
        organizationService: { assertOrganizationIsNotSuspended() {} },
        organizationBoxLimits: { resolve: async (organization) => organization },
        imageAdmissionService: { async assert() {}, async spendColdPullBudget() {} },
        imageResolverService: { resolve: async () => ({ ref: 'alpine:latest', isOrgOwned: false }) },
        redis: { exists: async () => 1 },
        runnerService: { getRandomAvailableRunner: async () => ({ id: randomUUID() }) },
        boxRepository: { insert: (box) => repository.save(box) },
        eventEmitter: { emitAsync: async () => {} },
        toBoxDto: (box) => BoxDto.fromBox(box, ''),
      })
      const input = createBoxToCreateBox({ name: `stored-${required}`, advanced: { nested_virtualization: required } })
      const result = await service.create(input, { id: randomUUID() } as never, Context.user())
      const stored = await repository.findOneByOrFail({ id: result.id })
      expect(stored.nestedVirtualization).toBe(required)
      expect(boxToBoxResponse(BoxDto.fromBox(stored, '')).advanced).toEqual({ nested_virtualization: required })
    },
  )
})

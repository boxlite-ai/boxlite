/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { JobStatus, JobType, ResourceType } from '../../box/dto/job.dto'
import { Job } from '../../box/entities/job.entity'
import { NamespaceMigrationJobsUnderBackup1786320000000 } from './1786320000000-namespace-migration-jobs-under-backup-migration'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `job_backup_ns_${process.pid}_${randomUUID().replaceAll('-', '')}`
const runnerId = 'runner-namespace-migration'
const stamped = new Date('2026-01-01T00:00:00.000Z')

const inFlightMigrationJobId = '00000000-0000-4000-8000-000000000021'
const completedMigrationJobId = '00000000-0000-4000-8000-000000000022'
const inFlightLifecycleJobId = '00000000-0000-4000-8000-000000000023'

function job(overrides: ConstructorParameters<typeof Job>[0]): Job {
  const created = new Job(overrides)
  // The staleness sweep measures its timeout from updatedAt, so the migration has
  // to leave it alone — which only means something if it starts out in the past.
  created.createdAt = stamped
  created.updatedAt = stamped
  return created
}

describeIfDatabase('NamespaceMigrationJobsUnderBackup1786320000000 (integration, real Postgres)', () => {
  let dataSource: DataSource
  let repository: Repository<Job>

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Job],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    await dataSource.synchronize()
    repository = dataSource.getRepository(Job)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }

    try {
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  it('moves only the still-open migration jobs into the BACKUP namespace', async () => {
    await repository.insert([
      job({
        id: inFlightMigrationJobId,
        type: JobType.EXPORT_BOX,
        status: JobStatus.IN_PROGRESS,
        runnerId,
        resourceType: ResourceType.BOX,
        resourceId: 'box-being-migrated',
      }),
      job({
        id: completedMigrationJobId,
        type: JobType.EXPORT_BOX,
        status: JobStatus.COMPLETED,
        runnerId,
        resourceType: ResourceType.BOX,
        resourceId: 'box-being-migrated',
        completedAt: stamped,
      }),
      job({
        id: inFlightLifecycleJobId,
        type: JobType.START_BOX,
        status: JobStatus.IN_PROGRESS,
        runnerId,
        resourceType: ResourceType.BOX,
        resourceId: 'box-being-started',
      }),
    ])

    const queryRunner = dataSource.createQueryRunner()
    try {
      // The migration names "job" unqualified, the way it will run against the
      // deployed schema. Point this connection at the throwaway schema so it
      // cannot reach a real one.
      await queryRunner.query(`SET search_path TO "${schemaName}"`)
      await new NamespaceMigrationJobsUnderBackup1786320000000().up(queryRunner)
    } finally {
      await queryRunner.release()
    }

    const rows = await repository.find({ order: { id: 'ASC' } })
    expect(rows.map((row) => [row.id, row.resourceType])).toEqual([
      [inFlightMigrationJobId, ResourceType.BACKUP],
      [completedMigrationJobId, ResourceType.BOX],
      [inFlightLifecycleJobId, ResourceType.BOX],
    ])

    const moved = rows.find((row) => row.id === inFlightMigrationJobId)
    expect(moved?.updatedAt.getTime()).toBe(stamped.getTime())
  })
})

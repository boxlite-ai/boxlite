/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import { DataSource, IsNull, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobConflictError } from '../errors/job-conflict.error'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `job_namespace_${process.pid}_${randomUUID().replaceAll('-', '')}`
const boxId = 'box-migration-namespace'
const runnerId = 'runner-migration-namespace'
const lifecycleJobId = '00000000-0000-4000-8000-000000000011'

/**
 * The job a user's start leaves incomplete on the runner still holding the box
 * — the row a migration job for the same box has to fit alongside.
 */
function incompleteLifecycleJob(): Job {
  return new Job({
    id: lifecycleJobId,
    type: JobType.START_BOX,
    runnerId,
    resourceType: ResourceType.BOX,
    resourceId: boxId,
  })
}

describeIfDatabase('JobService.createJob resource namespaces (integration, real Postgres)', () => {
  let dataSource: DataSource
  let repository: Repository<Job>
  let service: JobService

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
    // Redis only carries the "new job" nudge, and createJob already treats a
    // failed nudge as harmless: the runner polls for what it missed.
    service = new JobService(repository, {} as any, {} as any)
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

  beforeEach(async () => {
    await repository.clear()
    await repository.insert(incompleteLifecycleJob())
  })

  it('accepts a migration job for a box whose runner already has an incomplete lifecycle job', async () => {
    await service.createJob(null, JobType.ROLLBACK_EXPORT_BOX, runnerId, ResourceType.BACKUP, boxId)

    const incomplete = await repository.find({
      where: { resourceId: boxId, completedAt: IsNull() },
      order: { type: 'ASC' },
    })
    expect(incomplete.map((job) => [job.type, job.resourceType])).toEqual([
      [JobType.ROLLBACK_EXPORT_BOX, ResourceType.BACKUP],
      [JobType.START_BOX, ResourceType.BOX],
    ])
  })

  it('still rejects a second incomplete job in the namespace the lifecycle job holds', async () => {
    await expect(service.createJob(null, JobType.STOP_BOX, runnerId, ResourceType.BOX, boxId)).rejects.toBeInstanceOf(
      JobConflictError,
    )
  })
})

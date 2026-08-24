/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `job_claim_${process.pid}_${randomUUID().replaceAll('-', '')}`
const firstJobId = '00000000-0000-4000-8000-000000000001'
const secondJobId = '00000000-0000-4000-8000-000000000002'
const rejectedJobId = '00000000-0000-4000-8000-000000000003'
const rejectConstraint = 'reject_one_in_progress_job'

function claimPendingJobs(service: JobService, runnerId: string, limit: number) {
  return (service as any).claimPendingJobs(runnerId, limit) as Promise<Array<{ id: string; status: JobStatus }>>
}

function pendingJob(id: string, resourceId: string, createdAt: Date): Job {
  const job = new Job({
    id,
    type: JobType.CREATE_BOX,
    runnerId: 'runner-claim-integration',
    resourceType: ResourceType.BOX,
    resourceId,
  })
  job.createdAt = createdAt
  job.updatedAt = createdAt
  return job
}

describeIfDatabase('JobService.claimPendingJobs (integration, real Postgres)', () => {
  let dataSource: DataSource
  let repository: Repository<Job>
  let service: JobService
  let ownsSchema = false

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
    ownsSchema = true
    await dataSource.synchronize()
    repository = dataSource.getRepository(Job)
    service = new JobService(repository, {} as any, {} as any)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }

    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await repository.clear()
  })

  afterEach(async () => {
    await dataSource.query(
      `ALTER TABLE "${schemaName}"."job" DROP CONSTRAINT IF EXISTS "${rejectConstraint}"`,
    )
  })

  it('claims a persisted job without reconstructing the returned database row', async () => {
    const createdAt = new Date('2026-08-10T10:00:00.000Z')
    await repository.insert(pendingJob(firstJobId, 'box-claim-success', createdAt))

    const claimed = await claimPendingJobs(service, 'runner-claim-integration', 10)

    expect(claimed).toEqual([expect.objectContaining({ id: firstJobId, status: JobStatus.IN_PROGRESS })])
    expect(await repository.findOneByOrFail({ id: firstJobId })).toEqual(
      expect.objectContaining({ status: JobStatus.IN_PROGRESS, startedAt: expect.any(Date) }),
    )
  })

  it('leaves the whole selected batch pending when one claim update is rejected', async () => {
    await repository.insert([
      pendingJob(firstJobId, 'box-claim-first', new Date('2026-08-10T10:00:00.000Z')),
      pendingJob(rejectedJobId, 'box-claim-rejected', new Date('2026-08-10T10:00:01.000Z')),
      pendingJob(secondJobId, 'box-not-selected', new Date('2026-08-10T10:00:02.000Z')),
    ])
    await dataSource.query(
      `ALTER TABLE "${schemaName}"."job" ADD CONSTRAINT "${rejectConstraint}" CHECK ("id" <> '${rejectedJobId}' OR "status" <> '${JobStatus.IN_PROGRESS}')`,
    )

    await expect(claimPendingJobs(service, 'runner-claim-integration', 2)).rejects.toThrow()

    const selected = await repository.find({
      where: [{ id: firstJobId }, { id: rejectedJobId }],
      order: { createdAt: 'ASC' },
    })
    expect(selected.map((job) => job.status)).toEqual([JobStatus.PENDING, JobStatus.PENDING])
  })
})

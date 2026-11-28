/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { DataSource, Repository } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { Job } from '../entities/job.entity'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `job_runner_status_${process.pid}_${randomUUID().replaceAll('-', '')}`
const runnerId = 'runner-status-integration'

function updateRunnerJobStatus(
  service: JobService,
  jobId: string,
  runner: string,
  status: JobStatus,
  errorMessage?: string,
  resultMetadata?: string,
): Promise<Job> {
  return service.updateRunnerJobStatus(jobId, runner, status, errorMessage, resultMetadata)
}

describeIfDatabase('JobService.updateRunnerJobStatus (integration, real Postgres)', () => {
  let dataSource: DataSource
  let repository: Repository<Job>
  let service: JobService
  let ownsSchema = false
  const jobStateHandlerService = { handleJobCompletion: jest.fn().mockResolvedValue(undefined) }

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
      extra: { options: `-c search_path=${schemaName},public` },
      synchronize: false,
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    repository = dataSource.getRepository(Job)
    service = new JobService(repository, {} as any, jobStateHandlerService as any)
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
    jobStateHandlerService.handleJobCompletion.mockClear()
  })

  async function insertJob(
    status: JobStatus,
    payload: string | null = null,
    fields: Pick<Job, 'errorMessage' | 'resultMetadata'> = { errorMessage: null, resultMetadata: null },
  ): Promise<Job> {
    const job = new Job({
      type: JobType.CREATE_BOX,
      status,
      runnerId,
      resourceType: ResourceType.BOX,
      resourceId: `box-${randomUUID()}`,
      payload,
    })
    job.errorMessage = fields.errorMessage
    job.resultMetadata = fields.resultMetadata
    job.startedAt = status === JobStatus.PENDING ? null : new Date('2026-08-10T10:00:00.000Z')
    job.completedAt =
      status === JobStatus.COMPLETED || status === JobStatus.FAILED ? new Date('2026-08-10T10:01:00.000Z') : null
    await repository.insert(job)
    return job
  }

  it.each([
    [JobStatus.PENDING, JobStatus.FAILED],
    [JobStatus.IN_PROGRESS, JobStatus.COMPLETED],
    [JobStatus.PENDING, JobStatus.IN_PROGRESS],
    [JobStatus.IN_PROGRESS, JobStatus.FAILED],
    [JobStatus.PENDING, JobStatus.PENDING],
    [JobStatus.IN_PROGRESS, JobStatus.IN_PROGRESS],
    [JobStatus.COMPLETED, JobStatus.COMPLETED],
    [JobStatus.FAILED, JobStatus.FAILED],
  ])('allows %s -> %s', async (currentStatus, newStatus) => {
    const job = await insertJob(currentStatus)

    const updated = await updateRunnerJobStatus(service, job.id, runnerId, newStatus)

    expect(updated).toBeInstanceOf(Job)
    expect(updated.status).toBe(newStatus)
    expect(updated.version).toBe(2)
    expect(updated.createdAt).toBeInstanceOf(Date)
    expect(updated.updatedAt).toBeInstanceOf(Date)
    expect(updated.getResultMetadata()).toBeNull()
    expect(jobStateHandlerService.handleJobCompletion).toHaveBeenCalledTimes(
      newStatus === JobStatus.COMPLETED || newStatus === JobStatus.FAILED ? 1 : 0,
    )
  })

  it.each([
    [JobStatus.PENDING, JobStatus.COMPLETED],
    [JobStatus.IN_PROGRESS, JobStatus.PENDING],
    [JobStatus.COMPLETED, JobStatus.FAILED],
    [JobStatus.FAILED, JobStatus.COMPLETED],
    [JobStatus.COMPLETED, JobStatus.IN_PROGRESS],
    [JobStatus.COMPLETED, JobStatus.PENDING],
    [JobStatus.FAILED, JobStatus.IN_PROGRESS],
    [JobStatus.FAILED, JobStatus.PENDING],
  ])('rejects %s -> %s without changing the job', async (currentStatus, newStatus) => {
    const job = await insertJob(currentStatus)

    await expect(updateRunnerJobStatus(service, job.id, runnerId, newStatus)).rejects.toBeInstanceOf(ConflictException)

    const persisted = await repository.findOneByOrFail({ id: job.id })
    expect(persisted.status).toBe(currentStatus)
    expect(persisted.version).toBe(1)
    expect(jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
  })

  it('hides missing and foreign-runner jobs without updating them', async () => {
    const job = await insertJob(JobStatus.IN_PROGRESS)

    await expect(updateRunnerJobStatus(service, job.id, 'another-runner', JobStatus.COMPLETED)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(updateRunnerJobStatus(service, randomUUID(), runnerId, JobStatus.COMPLETED)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(updateRunnerJobStatus(service, 'not-a-uuid', runnerId, JobStatus.COMPLETED)).rejects.toBeInstanceOf(
      NotFoundException,
    )

    expect((await repository.findOneByOrFail({ id: job.id })).status).toBe(JobStatus.IN_PROGRESS)
    expect(jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
  })

  it('sets startedAt only on the first IN_PROGRESS update and increments version each time', async () => {
    const job = await insertJob(JobStatus.PENDING)

    const started = await updateRunnerJobStatus(service, job.id, runnerId, JobStatus.IN_PROGRESS)
    const repeated = await updateRunnerJobStatus(service, job.id, runnerId, JobStatus.IN_PROGRESS)

    expect(started.startedAt).toBeInstanceOf(Date)
    expect(started.completedAt).toBeNull()
    expect(repeated.startedAt).toEqual(started.startedAt)
    expect(started.version).toBe(2)
    expect(repeated.version).toBe(3)
    expect(repeated.updatedAt.getTime()).toBeGreaterThanOrEqual(started.updatedAt.getTime())
    expect(jobStateHandlerService.handleJobCompletion).not.toHaveBeenCalled()
  })

  it.each([JobStatus.COMPLETED, JobStatus.FAILED])(
    'rewrites completedAt and invokes completion handling on every %s retry',
    async (status) => {
      const job = await insertJob(JobStatus.IN_PROGRESS, null, {
        errorMessage: 'original error',
        resultMetadata: '{"old":true}',
      })

      const first = await updateRunnerJobStatus(service, job.id, runnerId, status, '', '')
      await new Promise((resolve) => setTimeout(resolve, 5))
      const retry = await updateRunnerJobStatus(
        service,
        job.id,
        runnerId,
        status,
        'new error',
        '{"new":true}',
      )

      expect(first.errorMessage).toBe('original error')
      expect(first.getResultMetadata()).toEqual({ old: true })
      expect(retry.errorMessage).toBe('new error')
      expect(retry.getResultMetadata()).toEqual({ new: true })
      expect(retry.completedAt).toBeInstanceOf(Date)
      expect(retry.completedAt!.getTime()).toBeGreaterThan(first.completedAt!.getTime())
      expect(retry.version).toBe(3)
      expect(jobStateHandlerService.handleJobCompletion).toHaveBeenCalledTimes(2)
      expect(jobStateHandlerService.handleJobCompletion).toHaveBeenNthCalledWith(2, retry)
    },
  )

  it.each([JobStatus.COMPLETED, JobStatus.FAILED])('removes secretCredential on %s', async (status) => {
    const job = await insertJob(
      JobStatus.IN_PROGRESS,
      JSON.stringify({ image: 'alpine', secretCredential: { token: 'private' } }),
    )

    const updated = await updateRunnerJobStatus(service, job.id, runnerId, status)

    expect(updated.getPayload()).toEqual({ image: 'alpine' })
    expect((await repository.findOneByOrFail({ id: job.id })).getPayload()).toEqual({ image: 'alpine' })
  })

  it.each(['null', 'false', '0', '""'])('preserves a falsey secretCredential value: %s', async (value) => {
    const payload = `{"image":"alpine","secretCredential":${value}}`
    const job = await insertJob(JobStatus.IN_PROGRESS, payload)

    const updated = await updateRunnerJobStatus(service, job.id, runnerId, JobStatus.COMPLETED)

    expect(updated.payload).toBe(payload)
    expect((await repository.findOneByOrFail({ id: job.id })).payload).toBe(payload)
  })

  it.each([
    ['malformed JSON', '{malformed'],
    ['a JSON array', '[{"secretCredential":"private"}]'],
    ['a JSON string', '"secretCredential"'],
    ['JSON null', 'null'],
  ])('completes CREATE_BOX without casting or changing %s', async (_label, payload) => {
    const job = await insertJob(JobStatus.IN_PROGRESS, payload)

    const updated = await updateRunnerJobStatus(service, job.id, runnerId, JobStatus.COMPLETED)

    expect(updated.payload).toBe(payload)
    expect(updated.status).toBe(JobStatus.COMPLETED)
    expect((await repository.findOneByOrFail({ id: job.id })).payload).toBe(payload)
  })
})

import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron } from '@nestjs/schedule'
import { randomUUID } from 'node:crypto'
import { EntityManager, Repository } from 'typeorm'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { JobDto, JobStatus, JobType } from '../dto/job.dto'
import { ResizePayload, validResources } from './resize-resources'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'

/** Resize alone reconciles durably; other jobs retain terminal failures. */
@Injectable()
export class ResizeJobService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResizeJobService.name)

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    private readonly cache: BoxLookupCacheInvalidationService,
  ) {}

  async claim(runnerId: string, limit: number): Promise<JobDto[]> {
    if (limit <= 0) return []
    return this.jobs.manager.transaction(async (manager) => {
      const jobs = await manager
        .createQueryBuilder(Job, 'job')
        .where('job.type = :type AND job.status = :status AND job.runnerId = :runnerId', {
          type: JobType.RESIZE_BOX,
          status: JobStatus.PENDING,
          runnerId,
        })
        .andWhere('job.resizePhase = :phase', { phase: 'APPLY' })
        .andWhere('job.nextAttemptAt <= statement_timestamp()')
        .orderBy('job.nextAttemptAt', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany()
      const now = await this.databaseTime(manager)
      for (const job of jobs) {
        job.status = JobStatus.IN_PROGRESS
        job.claimToken = randomUUID()
        job.attempt += 1
        job.startedAt = now
        job.leaseExpiresAt = new Date(now.getTime() + 120_000)
        await manager.save(Job, job)
      }
      return jobs.map((job) => new JobDto(job))
    })
  }

  async report(
    id: string,
    runnerId: string,
    token: string | undefined,
    status: JobStatus,
    errorMessage?: string,
    resultMetadata?: string,
  ): Promise<Job> {
    if (!token) throw new ConflictException('Resize job requires its current claim token')
    const identity = await this.jobs.findOneBy({ id, runnerId, type: JobType.RESIZE_BOX })
    if (!identity) throw new NotFoundException('Resize job not found')
    let completedBox: Box | undefined
    const result = await this.jobs.manager.transaction(async (manager) => {
      // Admission and billing take these locks in this order too.
      const box = await manager.findOne(Box, {
        where: { id: identity.resourceId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      const job = await manager.findOne(Job, { where: { id }, lock: { mode: 'pessimistic_write' } })
      const now = await this.databaseTime(manager)
      if (
        !job ||
        job.runnerId !== runnerId ||
        job.claimToken !== token ||
        job.status !== JobStatus.IN_PROGRESS ||
        job.resizePhase !== 'APPLY' ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= now ||
        box?.resizeJobId !== id
      ) {
        throw new ConflictException('Resize claim expired or was replaced')
      }
      if (status === JobStatus.IN_PROGRESS) {
        job.leaseExpiresAt = new Date(now.getTime() + 120_000)
      } else if (status === JobStatus.COMPLETED) {
        const target = job.getPayload<ResizePayload>()
        let observed: unknown
        try {
          observed = JSON.parse(resultMetadata ?? 'null')
        } catch {
          observed = null
        }
        if (
          !target ||
          target.version !== 1 ||
          !validResources(observed) ||
          observed.cpus !== target.cpus ||
          observed.memory_mib !== target.memory_mib
        ) {
          throw new ConflictException('Resize completion must confirm the immutable target')
        }
        job.status = JobStatus.COMPLETED
        job.resultMetadata = resultMetadata!
        job.completedAt = now
        job.leaseExpiresAt = null
        job.claimToken = null
        job.errorMessage = null
        await manager.update(Box, box.id, { pending: false, resizeJobId: null })
        completedBox = box
      } else if (status === JobStatus.FAILED) {
        job.status = JobStatus.PENDING
        job.claimToken = null
        job.leaseExpiresAt = null
        job.errorMessage = errorMessage || 'Resize attempt failed'
        const delay = Math.min(60, 2 ** Math.min(6, Math.max(0, job.attempt - 1)))
        job.nextAttemptAt = new Date(now.getTime() + Math.ceil(Math.max(1, delay * (0.5 + Math.random() * 0.5)) * 1000))
        this.logger.error({
          jobId: job.id,
          boxId: job.resourceId,
          runnerId,
          attempt: job.attempt,
          nextAttemptAt: job.nextAttemptAt,
          error: job.errorMessage,
          message: 'Resize will retry',
        })
      } else {
        throw new ConflictException('Unsupported resize job report')
      }
      return manager.save(Job, job)
    })
    if (completedBox)
      this.cache.invalidate({
        id: completedBox.id,
        organizationId: completedBox.organizationId,
        name: completedBox.name,
      })
    return result
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverExpired()
  }

  @Cron('*/15 * * * * *', { name: 'recover-resize-leases' })
  async recoverExpired(): Promise<void> {
    try {
      const result = await this.jobs
        .createQueryBuilder()
        .update(Job)
        .set({
          status: JobStatus.PENDING,
          claimToken: null,
          leaseExpiresAt: null,
          errorMessage: 'Resize lease expired; retrying the persisted target',
          nextAttemptAt: () => "statement_timestamp() + interval '1 second'",
        })
        .where('type = :type AND status = :status', { type: JobType.RESIZE_BOX, status: JobStatus.IN_PROGRESS })
        .andWhere('"leaseExpiresAt" <= statement_timestamp()')
        .execute()
      if (result.affected) this.logger.warn({ message: 'Requeued expired resize leases', count: result.affected })
    } catch (error) {
      this.logger.error('Failed to recover resize leases', error)
    }
  }

  private async databaseTime(manager: EntityManager): Promise<Date> {
    const [{ now }] = await manager.query('SELECT statement_timestamp() AS now')
    return new Date(now)
  }
}

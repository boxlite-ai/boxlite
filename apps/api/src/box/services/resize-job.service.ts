import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron } from '@nestjs/schedule'
import { randomUUID } from 'node:crypto'
import { EntityManager, Repository } from 'typeorm'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { JobDto, JobStatus, JobType } from '../dto/job.dto'
import {
  RESIZE_LEASE_MS,
  RESIZE_LOCK_TIMEOUT_MS,
  RESIZE_MAX_ATTEMPTS,
  RESIZE_TERMINAL_GRACE_MS,
  ResizePayload,
  validResources,
} from './resize-resources'
import { UsageService } from '../../usage/services/usage.service'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { runnerJobQueueKey } from '../constants/runner-job-queue'

/**
 * Resize uses a leased Job with bounded retries. Completion commits the Box
 * size, the usage-period switch and the Job together; terminal failure releases
 * the lifecycle fence and leaves Box and billing unchanged.
 */
@Injectable()
export class ResizeJobService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResizeJobService.name)

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    private readonly usage: UsageService,
    private readonly cache: BoxLookupCacheInvalidationService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async claim(runnerId: string, limit: number, ids?: string[]): Promise<JobDto[]> {
    if (limit <= 0 || ids?.length === 0) return []
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
        .andWhere('(job.resizeDeadlineAt IS NULL OR job.resizeDeadlineAt > statement_timestamp())')
        .andWhere('job.attempt < :maxAttempts', { maxAttempts: RESIZE_MAX_ATTEMPTS })
        .andWhere(ids ? 'job.id IN (:...ids)' : 'TRUE', { ids })
        .orderBy('job.createdAt', 'ASC')
        .addOrderBy('job.id', 'ASC')
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
        job.leaseExpiresAt = new Date(now.getTime() + RESIZE_LEASE_MS)
        await manager.save(Job, job)
      }
      return jobs.map((job) => new JobDto(job))
    })
  }

  async nextAttemptDelaySeconds(runnerId: string): Promise<number | undefined> {
    const next = await this.jobs
      .createQueryBuilder('job')
      .select('EXTRACT(EPOCH FROM (MIN(job.nextAttemptAt) - statement_timestamp()))', 'seconds')
      .where('job.runnerId = :runnerId AND job.type = :type AND job.status = :status', {
        runnerId,
        type: JobType.RESIZE_BOX,
        status: JobStatus.PENDING,
      })
      .andWhere('job.resizePhase = :phase', { phase: 'APPLY' })
      .andWhere('job.attempt < :maxAttempts', { maxAttempts: RESIZE_MAX_ATTEMPTS })
      .andWhere('(job.resizeDeadlineAt IS NULL OR job.resizeDeadlineAt > statement_timestamp())')
      .getRawOne<{ seconds: string | null }>()
    return next?.seconds == null ? undefined : Number(next.seconds)
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
    if (status === JobStatus.COMPLETED) {
      return this.complete(id, identity.resourceId, runnerId, token, resultMetadata)
    }
    return this.reportProgress(id, identity.resourceId, runnerId, token, status, errorMessage)
  }

  private async complete(
    id: string,
    boxId: string,
    runnerId: string,
    token: string,
    resultMetadata?: string,
  ): Promise<Job> {
    let completedBox: Box | undefined
    const job = await this.usage.withResourceLock(boxId, async (signal) =>
      this.jobs.manager.transaction(async (manager) => {
        const box = await manager.findOne(Box, {
          where: { id: boxId },
          lock: { mode: 'pessimistic_write' },
          loadEagerRelations: false,
        })
        const job = await manager.findOne(Job, { where: { id }, lock: { mode: 'pessimistic_write' } })
        const now = await this.databaseTime(manager)
        if (!job || job.runnerId !== runnerId) {
          throw new ConflictException('Resize claim expired or was replaced')
        }

        const target = job.getPayload<ResizePayload>()
        const observed = this.parseObserved(resultMetadata)
        const exactTarget =
          !!target &&
          target.version === 1 &&
          validResources(observed) &&
          observed.cpus === target.cpus &&
          observed.memory_mib === target.memory_mib

        // A duplicate report after a lost HTTP response must not switch billing twice.
        if (job.status === JobStatus.COMPLETED && job.completedAt) {
          if (!exactTarget) throw new ConflictException('Resize completion does not match the completed job')
          return job
        }
        if (job.status === JobStatus.FAILED && job.completedAt) {
          throw new ConflictException('Resize already failed and is no longer claimable')
        }
        if (
          !box ||
          box.resizeJobId !== id ||
          job.claimToken !== token ||
          job.status !== JobStatus.IN_PROGRESS ||
          job.resizePhase !== 'APPLY' ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt <= now ||
          (job.resizeDeadlineAt !== null && job.resizeDeadlineAt <= now)
        ) {
          throw new ConflictException('Resize claim expired or was replaced')
        }
        if (!exactTarget || !target) {
          throw new ConflictException('Resize completion must confirm the immutable target')
        }

        signal.throwIfAborted()
        const memoryGiB = Math.ceil(target.memory_mib / 1024)
        // Keep the in-memory entity in step so the period shape reads the target.
        Object.assign(box, { cpu: target.cpus, mem: memoryGiB })
        await manager.update(Box, box.id, {
          cpu: target.cpus,
          mem: memoryGiB,
          resizeJobId: null,
          pending: String(box.state) === String(box.desiredState) ? false : box.pending,
          updatedAt: now,
        })
        await this.usage.closeUsagePeriod(box.id, manager, now)
        await this.usage.openUsagePeriodFor(box, box.state, manager, now)

        job.status = JobStatus.COMPLETED
        job.resultMetadata = resultMetadata ?? null
        job.completedAt = now
        job.resizePhase = null
        job.nextAttemptAt = null
        job.resizeDeadlineAt = null
        job.leaseExpiresAt = null
        job.claimToken = null
        job.errorMessage = null
        completedBox = box
        signal.throwIfAborted()
        return manager.save(Job, job)
      }),
    )

    if (completedBox) {
      this.cache.invalidate({
        id: completedBox.id,
        organizationId: completedBox.organizationId,
        name: completedBox.name,
      })
    }
    return job
  }

  private async reportProgress(
    id: string,
    boxId: string,
    runnerId: string,
    token: string,
    status: JobStatus,
    errorMessage?: string,
  ): Promise<Job> {
    if (status !== JobStatus.IN_PROGRESS && status !== JobStatus.FAILED) {
      throw new ConflictException('Unsupported resize job report')
    }

    let changedBox: Box | undefined
    const job = await this.jobs.manager.transaction(async (manager) => {
      const box = await manager.findOne(Box, {
        where: { id: boxId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      const job = await manager.findOne(Job, { where: { id }, lock: { mode: 'pessimistic_write' } })
      const now = await this.databaseTime(manager)
      if (!job || job.runnerId !== runnerId) {
        throw new ConflictException('Resize claim expired or was replaced')
      }
      if (job.status === JobStatus.COMPLETED && job.completedAt) return job
      if (job.status === JobStatus.FAILED && job.completedAt) {
        throw new ConflictException('Resize already failed and is no longer claimable')
      }
      if (
        !box ||
        box.resizeJobId !== id ||
        job.claimToken !== token ||
        job.status !== JobStatus.IN_PROGRESS ||
        job.resizePhase !== 'APPLY' ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= now
      ) {
        throw new ConflictException('Resize claim expired or was replaced')
      }

      if (status === JobStatus.IN_PROGRESS) {
        if (job.resizeDeadlineAt !== null && job.resizeDeadlineAt <= now) {
          throw new ConflictException('Resize deadline expired')
        }
        job.leaseExpiresAt = new Date(now.getTime() + RESIZE_LEASE_MS)
        return manager.save(Job, job)
      }

      const terminal = this.isAtBound(job, now)
      if (!terminal) {
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
        return manager.save(Job, job)
      }

      this.markTerminal(job, now, errorMessage)
      await manager.save(Job, job)
      if (box.resizeJobId === job.id) {
        await manager.update(Box, box.id, {
          resizeJobId: null,
          pending: String(box.state) === String(box.desiredState) ? false : box.pending,
          updatedAt: now,
        })
        changedBox = box
      }
      return job
    })

    if (changedBox) {
      this.cache.invalidate({
        id: changedBox.id,
        organizationId: changedBox.organizationId,
        name: changedBox.name,
      })
    }
    if (job.status === JobStatus.PENDING) await this.notifyRetry(job)
    return job
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.reapResizeJobs()
  }

  @Cron('*/15 * * * * *', { name: 'reap-resize-jobs', waitForCompletion: true })
  async reapResizeJobs(): Promise<void> {
    await this.requeueExpiredLeases()
    await this.failExhaustedJobs()
  }

  private async requeueExpiredLeases(): Promise<void> {
    try {
      const [rows]: [Array<Pick<Job, 'id' | 'runnerId'>>, number] = await this.jobs.query(
        `UPDATE "job"
         SET "status" = $1,
             "claimToken" = NULL,
             "leaseExpiresAt" = NULL,
             "errorMessage" = $2,
             "nextAttemptAt" = statement_timestamp() + ((1 + floor(random() * 5))::int * interval '1 second')
         WHERE "id" IN (
           SELECT "id" FROM "job"
           WHERE "type" = $3 AND "status" = $4
             AND "leaseExpiresAt" <= statement_timestamp()
             AND "attempt" < $5
             AND ("resizeDeadlineAt" IS NULL OR "resizeDeadlineAt" > statement_timestamp())
           FOR UPDATE SKIP LOCKED
         )
         RETURNING "id", "runnerId"`,
        [
          JobStatus.PENDING,
          'Resize lease expired; retrying the persisted target',
          JobType.RESIZE_BOX,
          JobStatus.IN_PROGRESS,
          RESIZE_MAX_ATTEMPTS,
        ],
      )
      if (rows.length) this.logger.warn({ message: 'Requeued expired resize leases', count: rows.length })
      await Promise.all(rows.map((job) => this.notifyRetry(job)))
    } catch (error) {
      this.logger.error('Failed to requeue expired resize leases', error)
    }
  }

  private async notifyRetry(job: Pick<Job, 'id' | 'runnerId'>): Promise<void> {
    // Called after commit: the hint wakes an existing poll, whose next request
    // bounds its wait by the durable nextAttemptAt even if this hint is lost.
    try {
      await this.redis.lpush(runnerJobQueueKey(job.runnerId), job.id)
    } catch (error) {
      this.logger.warn(`Failed to notify runner ${job.runnerId} of resize retry: ${error.message}`)
    }
  }

  private async failExhaustedJobs(): Promise<void> {
    let rows: Array<{ id: string }> = []
    try {
      rows = await this.jobs.query(
        `SELECT id FROM "job"
         WHERE "type" = $1 AND "completedAt" IS NULL AND (
           ("status" = $2 AND ("resizeDeadlineAt" <= statement_timestamp() OR "attempt" >= $3::int))
           OR
           ("status" = $4 AND (
             ("resizeDeadlineAt" IS NOT NULL
               AND "resizeDeadlineAt" + ($5::int * interval '1 millisecond') <= statement_timestamp())
             OR
             (("leaseExpiresAt" IS NULL
               OR "leaseExpiresAt" + ($5::int * interval '1 millisecond') <= statement_timestamp())
               AND "attempt" >= $3::int)
           ))
         )
         ORDER BY "createdAt" ASC
         LIMIT 100`,
        [JobType.RESIZE_BOX, JobStatus.PENDING, RESIZE_MAX_ATTEMPTS, JobStatus.IN_PROGRESS, RESIZE_TERMINAL_GRACE_MS],
      )
    } catch (error) {
      this.logger.error('Failed to scan exhausted resize jobs', error)
      return
    }

    for (const row of rows) {
      await this.terminalizeFailedJob(row.id).catch((error) =>
        this.logger.error(`Failed to terminalize resize job ${row.id}`, error),
      )
    }
  }

  private async terminalizeFailedJob(id: string): Promise<void> {
    let changedBox: Box | undefined
    await this.jobs.manager.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '${RESIZE_LOCK_TIMEOUT_MS}ms'`)
      const identity = await manager.findOneBy(Job, { id })
      if (!identity) return
      const box = await manager.findOne(Box, {
        where: { id: identity.resourceId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      const job = await manager.findOne(Job, { where: { id }, lock: { mode: 'pessimistic_write' } })
      const now = await this.databaseTime(manager)
      if (!job || job.completedAt) return
      if (!this.isExhausted(job, now)) return

      this.markTerminal(job, now, job.errorMessage ?? undefined)
      await manager.save(Job, job)
      if (box && box.resizeJobId === job.id) {
        await manager.update(Box, box.id, {
          resizeJobId: null,
          pending: String(box.state) === String(box.desiredState) ? false : box.pending,
          updatedAt: now,
        })
        changedBox = box
      }
    })

    if (changedBox) {
      this.cache.invalidate({
        id: changedBox.id,
        organizationId: changedBox.organizationId,
        name: changedBox.name,
      })
    }
  }

  private isAtBound(job: Job, now: Date): boolean {
    return job.attempt >= RESIZE_MAX_ATTEMPTS || (job.resizeDeadlineAt !== null && job.resizeDeadlineAt <= now)
  }

  private isExhausted(job: Job, now: Date): boolean {
    if (job.status === JobStatus.PENDING) return this.isAtBound(job, now)
    if (job.status !== JobStatus.IN_PROGRESS) return false
    const pastDeadline =
      job.resizeDeadlineAt !== null && job.resizeDeadlineAt.getTime() + RESIZE_TERMINAL_GRACE_MS <= now.getTime()
    const leaseGone =
      job.leaseExpiresAt === null || job.leaseExpiresAt.getTime() + RESIZE_TERMINAL_GRACE_MS <= now.getTime()
    return pastDeadline || (leaseGone && job.attempt >= RESIZE_MAX_ATTEMPTS)
  }

  private markTerminal(job: Job, now: Date, lastError?: string): void {
    const timedOut = job.resizeDeadlineAt !== null && job.resizeDeadlineAt <= now
    const reason = timedOut
      ? 'Resize timed out'
      : job.attempt > 0
        ? `Resize failed after ${job.attempt} attempt(s)`
        : 'Resize expired before it was claimed'
    job.status = JobStatus.FAILED
    job.completedAt = now
    job.resizePhase = null
    job.nextAttemptAt = null
    job.resizeDeadlineAt = null
    job.claimToken = null
    job.leaseExpiresAt = null
    job.errorMessage = lastError ? `${reason}: ${lastError}` : reason
  }

  private parseObserved(resultMetadata?: string): unknown {
    try {
      return JSON.parse(resultMetadata ?? 'null')
    } catch {
      return null
    }
  }

  private async databaseTime(manager: EntityManager): Promise<Date> {
    const [{ now }] = await manager.query('SELECT statement_timestamp() AS now')
    return new Date(now)
  }
}

import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Cron, CronExpression } from '@nestjs/schedule'
import { isDeepStrictEqual } from 'node:util'
import { DataSource, EntityManager, In } from 'typeorm'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { Box } from '../entities/box.entity'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { Checkpoint } from '../entities/checkpoint.entity'
import { Job } from '../entities/job.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType, PROTECTED_CHECKPOINT_JOB_TYPES } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { sameCompleteOutboundSnapshot, validCompleteOutboundSnapshot } from '../runner-adapter/outbound-control'
import { CheckpointArchiveStore } from '../stores/checkpoint-archive.store'
import { completeOutboundRecord, lockCompleteOutboundFloor } from '../stores/outbound-policy.store'
import {
  checkpointEnrollment,
  ownsProtectedCheckpoint,
  ProtectedCheckpointPayload,
  verifiedCheckpointRetirement,
} from '../stores/protected-checkpoint.store'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { validateArchive } from './checkpoint-job-receiver.service'
import { JobService } from './job.service'

type Worker = { runner: RunnerContext; token: string }
type Work = { job: Job; payload: ProtectedCheckpointPayload; checkpoint: Checkpoint }
type Change = { box: Box; previous: BoxState }
type Reconciliation = { change?: Change; archive?: Checkpoint }

// Keep these predicates literal so they imply the partial index predicate even in a generic plan.
const protectedTypesSql = PROTECTED_CHECKPOINT_JOB_TYPES.map((type) => `'${type}'`).join(', ')
const unfinishedProtectedJobs = `job.type IN (${protectedTypesSql})
  AND (job."completedAt" IS NULL OR job."checkpointCleanupRequired")`

@Injectable()
export class ProtectedCheckpointJobService {
  private readonly logger = new Logger(ProtectedCheckpointJobService.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly jobs: JobService,
    private readonly archives: CheckpointArchiveStore,
    private readonly cache: BoxLookupCacheInvalidationService,
    private readonly events: EventEmitter2,
  ) {}

  async claim(runner: RunnerContext, token: string | undefined) {
    const worker = this.worker(runner, token)
    return this.dataSource.transaction(async (manager) => {
      const enrollment = await checkpointEnrollment(manager, runner.runnerId, worker)
      if (!enrollment) throw new ForbiddenException('Runner has no protected checkpoint lease')
      const job = await manager
        .createQueryBuilder(Job, 'job')
        .where(unfinishedProtectedJobs)
        .andWhere('job."runnerId" = :runnerId', { runnerId: runner.runnerId })
        .andWhere(
          `CASE WHEN job.type IN (${protectedTypesSql}) THEN CAST(job.payload AS jsonb) ->> 'lease_id' END = :lease`,
          { lease: enrollment.lease_id },
        )
        .andWhere(
          `(job."checkpointCleanupRequired" OR (:active AND (job.status = :started OR
          (job.status = :pending AND (job.type <> :restore OR :open)))))`,
          {
            pending: JobStatus.PENDING,
            started: JobStatus.IN_PROGRESS,
            active: !enrollment.expired && !enrollment.retiring,
            restore: JobType.IMPORT_PROTECTED_CHECKPOINT,
            open: enrollment.phase === 'open',
          },
        )
        .orderBy('job."updatedAt"', 'ASC')
        .addOrderBy('job.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .limit(1)
        .getOne()
      if (!job) return null
      const work = await this.work(manager, job)
      if (!ownsProtectedCheckpoint(work.payload, enrollment)) return null
      if (!job.checkpointCleanupRequired && !(await this.leaseIsActive(manager, work))) return null
      const starts = !job.checkpointCleanupRequired && job.status === JobStatus.PENDING
      await this.allowUpdates(manager)
      await manager.update(Job, job.id, {
        ...(starts ? { status: JobStatus.IN_PROGRESS, startedAt: new Date() } : {}),
        // Rotate retries even when a worker cannot acknowledge cleanup or report a receipt.
        updatedAt: () => 'clock_timestamp()',
      })
      return {
        id: job.id,
        type: job.type,
        resourceId: job.resourceId,
        cleanup: job.checkpointCleanupRequired,
        cleanupPublished: job.checkpointCleanupRequired && job.status === JobStatus.COMPLETED,
        payload: work.payload,
      }
    })
  }

  async authorize(runner: RunnerContext, token: string | undefined, jobId: string, cleanup: boolean): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const work = await this.workerWork(manager, this.worker(runner, token), jobId)
      if (
        cleanup
          ? !work.job.checkpointCleanupRequired
          : work.job.completedAt ||
            work.job.status !== JobStatus.IN_PROGRESS ||
            !(await this.restoreTargetAvailable(manager, work)) ||
            !(await this.leaseIsActive(manager, work))
      ) {
        throw new ConflictException('Protected checkpoint operation is no longer active')
      }
    })
  }

  async accept(runner: RunnerContext, token: string | undefined, id: string, value: unknown): Promise<void> {
    const result = await this.dataSource.transaction(async (manager) => {
      const work = await this.workerWork(manager, this.worker(runner, token), id)
      const proof = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      const { job } = work
      if (proof.kind !== job.type) throw new ConflictException('Protected checkpoint receipt kind does not match')
      if (proof.outcome === 'cleaned' && job.completedAt) {
        const change = job.checkpointCleanupRequired ? await this.completeCleanup(manager, work) : undefined
        return { rejected: false, change }
      }
      if (job.completedAt) {
        return { rejected: job.status !== JobStatus.COMPLETED || !isDeepStrictEqual(job.getResultMetadata(), proof) }
      }
      if (job.status !== JobStatus.IN_PROGRESS || !(await this.leaseIsActive(manager, work))) {
        throw new ConflictException('Protected checkpoint claim is stale')
      }
      await this.allowUpdates(manager)
      const applied = proof.outcome === 'completed' ? await this.apply(manager, work, proof) : null
      if (!applied) {
        const change = await this.fail(manager, work)
        return { rejected: proof.outcome !== 'failed', change }
      }
      if (!(await this.leaseIsActive(manager, work))) {
        throw new ConflictException('Protected checkpoint claim expired during receipt processing')
      }
      await manager.update(Job, job.id, {
        status: JobStatus.COMPLETED,
        completedAt: new Date(),
        resultMetadata: JSON.stringify(proof),
        checkpointCleanupRequired: job.type === JobType.UPLOAD_PROTECTED_CHECKPOINT,
      })
      return { rejected: false, change: applied.change }
    })
    this.publish(result.change)
    if (result.rejected) throw new ConflictException('Protected checkpoint receipt was rejected')
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'reconcile-protected-checkpoint-jobs', waitForCompletion: true })
  async reconcile(): Promise<void> {
    let after: string | undefined
    for (;;) {
      const query = this.dataSource
        .getRepository(Job)
        .createQueryBuilder('job')
        .where(unfinishedProtectedJobs)
        .orderBy('job.id', 'ASC')
        .limit(100)
      if (after) query.andWhere('job.id > :after', { after })
      const jobs = await query.getMany()
      if (!jobs.length) return
      for (const job of jobs) {
        try {
          let result = await this.reconcileJob(job)
          if (result?.archive) {
            const { archive } = result
            // The terminal job retains ownership of this immutable key while storage is contacted.
            await this.archives.remove(archive, true)
            result = await this.reconcileJob(job, archive)
          }
          this.publish(result?.change)
        } catch (error) {
          this.logger.debug(`Protected checkpoint job ${job.id} still requires reconciliation: ${error.message}`)
        }
      }
      after = jobs[jobs.length - 1].id
    }
  }

  private async reconcileJob(job: Job, removedArchive?: Checkpoint): Promise<Reconciliation | undefined> {
    return this.dataSource.transaction(async (manager) => {
      const enrollment = await checkpointEnrollment(manager, job.runnerId)
      await lockCompleteOutboundFloor(manager)
      const current = await this.lockJob(manager, job.id, job.runnerId)
      const work = await this.work(manager, current)
      if (current.completedAt) {
        if (
          !current.checkpointCleanupRequired ||
          !ownsProtectedCheckpoint(work.payload, enrollment) ||
          !verifiedCheckpointRetirement(enrollment)
        )
          return
        if (current.type !== JobType.IMPORT_PROTECTED_CHECKPOINT && current.status === JobStatus.FAILED) {
          const { checkpoint } = work
          if (checkpoint.state !== 'failed' || checkpoint.activeJobId !== current.id) return
          if (!removedArchive) return { archive: checkpoint }
          if (
            removedArchive.id !== checkpoint.id ||
            removedArchive.organizationId !== checkpoint.organizationId ||
            removedArchive.arcPath !== checkpoint.arcPath
          )
            return
        }
        return { change: await this.completeCleanup(manager, work) }
      }
      if (
        !ownsProtectedCheckpoint(work.payload, enrollment) ||
        (enrollment.phase !== 'open' &&
          current.type === JobType.IMPORT_PROTECTED_CHECKPOINT &&
          current.status === JobStatus.PENDING) ||
        !(await this.restoreTargetAvailable(manager, work)) ||
        !(await this.leaseIsActive(manager, work))
      ) {
        return { change: await this.fail(manager, work) }
      }
    })
  }

  private async apply(
    manager: EntityManager,
    work: Work,
    proof: Record<string, unknown>,
  ): Promise<{ change?: Change } | null> {
    const { checkpoint, job, payload } = work
    if (job.type === JobType.IMPORT_PROTECTED_CHECKPOINT) {
      const target = await this.target(manager, work)
      const restore = payload.restore
      if (
        !target ||
        !restore ||
        checkpoint.state !== 'ready' ||
        target.box.desiredState === BoxDesiredState.DESTROYED ||
        proof.operationId !== restore.operationId ||
        proof.targetSequence !== restore.targetSequence ||
        typeof proof.nativeId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(proof.nativeId) ||
        !validCompleteOutboundSnapshot(proof.targetOutbound) ||
        !sameCompleteOutboundSnapshot(restore.targetOutbound, proof.targetOutbound)
      )
        return null
      const { box, state, operation } = target
      const previous = box.state
      const snapshot = restore.targetOutbound
      Object.assign(box, {
        state: BoxState.STOPPED,
        pending: false,
        errorReason: null,
        recoverable: false,
        completeOutboundControl: { version: 2, committed: snapshot },
        completeOutboundGeneration: 1,
        outboundEnabled: snapshot.policy.mode === 'enabled',
        outboundAllowNet: snapshot.policy.allow_net,
      })
      box.assertValid()
      box.enforceInvariants()
      await manager.save(Box, box)
      await manager.update(BoxCheckpointState, { boxId: state.boxId }, { activeJobId: null })
      await manager.update(CheckpointOperation, operation.id, { state: 'completed', nativeId: proof.nativeId })
      return { change: { box, previous } }
    }
    if (checkpoint.activeJobId !== job.id || checkpoint.state !== 'creating' || !checkpoint.captureOutbound) return null
    const archive = validateArchive(proof.archive as Record<string, unknown> | null, checkpoint)
    if (
      !archive ||
      !validCompleteOutboundSnapshot(proof.captureOutbound) ||
      !sameCompleteOutboundSnapshot(checkpoint.captureOutbound, proof.captureOutbound)
    )
      return null
    if (job.type === JobType.UPLOAD_PROTECTED_CHECKPOINT) {
      if (job.resourceId !== checkpoint.id || !isDeepStrictEqual(archive, checkpoint.archive)) return null
      await manager.update(Checkpoint, checkpoint.id, { state: 'ready' })
    } else {
      if (checkpoint.exportJobId !== job.id || job.resourceId !== checkpoint.sourceBoxId) return null
      const source = await manager
        .createQueryBuilder(Box, 'box')
        .addSelect(['box.completeOutboundControl', 'box.completeOutboundGeneration'])
        .where({ id: checkpoint.sourceBoxId, organizationId: checkpoint.organizationId })
        .setLock('pessimistic_write')
        .getOne()
      const control = source && completeOutboundRecord(source)
      if (
        !source ||
        source.runnerId !== job.runnerId ||
        source.state !== checkpoint.sourceState ||
        source.completeOutboundGeneration !== payload.sourceGeneration ||
        !control?.committed ||
        control.pending ||
        control.finalization ||
        !sameCompleteOutboundSnapshot(control.committed, checkpoint.captureOutbound)
      )
        return null
      await this.releaseSource(manager, work)
      const upload = await this.jobs.createJob(
        manager,
        JobType.UPLOAD_PROTECTED_CHECKPOINT,
        job.runnerId,
        ResourceType.CHECKPOINT,
        checkpoint.id,
        { ...payload, archive },
      )
      await manager.update(Checkpoint, checkpoint.id, { archive, activeJobId: upload.id })
    }
    return {}
  }

  private async fail(manager: EntityManager, work: Work): Promise<Change | undefined> {
    const { job, checkpoint } = work
    const cleanupRequired = job.status === JobStatus.IN_PROGRESS || job.type === JobType.UPLOAD_PROTECTED_CHECKPOINT
    await this.allowUpdates(manager)
    await manager.update(Job, job.id, {
      status: JobStatus.FAILED,
      completedAt: new Date(),
      checkpointCleanupRequired: cleanupRequired,
    })
    if (job.type === JobType.IMPORT_PROTECTED_CHECKPOINT) {
      const disposalChange = cleanupRequired ? undefined : await this.confirmRestoreDisposal(manager, work)
      const target = await this.target(manager, work)
      if (!target) return disposalChange
      const { box, operation } = target
      const previous = box.state
      const errorReason = 'Protected checkpoint restore failed'
      await manager.update(CheckpointOperation, operation.id, { state: 'failed', errorReason })
      if (box.desiredState === BoxDesiredState.DESTROYED) return
      Object.assign(box, { state: BoxState.ERROR, errorReason, recoverable: false })
      await manager.save(Box, box)
      return { box, previous }
    }
    if (checkpoint.activeJobId === job.id) {
      await manager.update(Checkpoint, checkpoint.id, {
        state: 'failed',
        errorReason: 'Protected checkpoint capture failed',
        ...(cleanupRequired ? {} : { activeJobId: null }),
      })
      await this.releaseSource(manager, work)
    }
  }

  private async completeCleanup(manager: EntityManager, work: Work): Promise<Change | undefined> {
    const restore = work.job.type === JobType.IMPORT_PROTECTED_CHECKPOINT
    if (!restore && work.checkpoint.activeJobId === work.job.id) {
      await manager.update(Checkpoint, work.checkpoint.id, { activeJobId: null })
    }
    const change = restore ? await this.confirmRestoreDisposal(manager, work) : undefined
    await this.allowUpdates(manager)
    await manager.update(Job, work.job.id, { checkpointCleanupRequired: false })
    return change
  }

  private async confirmRestoreDisposal(
    manager: EntityManager,
    { job, payload, checkpoint }: Work,
  ): Promise<Change | undefined> {
    const restore = payload.restore
    if (!restore || restore.targetBoxId !== job.resourceId)
      throw new ConflictException('Restore lacks its target identity')
    const operation = await manager.findOneByOrFail(CheckpointOperation, {
      id: restore.operationId,
      jobId: job.id,
      sequence: restore.targetSequence,
      checkpointId: checkpoint.id,
      boxId: job.resourceId,
      runnerId: job.runnerId,
      state: In(['pending', 'failed', 'cancelled']),
    })
    await manager.update(CheckpointOperation, operation.id, { protectedDisposalConfirmed: true })
    if (operation.state !== 'cancelled') return
    const box = await manager.findOne(Box, {
      where: { id: operation.boxId, organizationId: checkpoint.organizationId, runnerId: operation.runnerId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!box || box.desiredState !== BoxDesiredState.DESTROYED || box.state === BoxState.DESTROYED) return
    const previous = box.state
    Object.assign(box, { state: BoxState.DESTROYED, errorReason: null, recoverable: false })
    box.enforceInvariants()
    await manager.save(Box, box)
    return { box, previous }
  }

  private async releaseSource(manager: EntityManager, { job, checkpoint }: Work): Promise<void> {
    if (job.type !== JobType.EXPORT_PROTECTED_CHECKPOINT) return
    const box = await manager.findOne(Box, {
      where: { id: checkpoint.sourceBoxId },
      lock: { mode: 'pessimistic_write' },
    })
    const slot = await manager.findOne(BoxCheckpointState, {
      where: { boxId: checkpoint.sourceBoxId },
      lock: { mode: 'pessimistic_write' },
    })
    if (slot?.activeJobId !== job.id) return
    await manager.update(BoxCheckpointState, { boxId: slot.boxId }, { activeJobId: null })
    if (box?.state === checkpoint.sourceState && String(box.desiredState) === String(checkpoint.sourceState)) {
      await manager.update(Box, box.id, { pending: false })
    }
  }

  private async restoreTargetAvailable(manager: EntityManager, work: Work): Promise<boolean> {
    if (work.job.type !== JobType.IMPORT_PROTECTED_CHECKPOINT) return true
    const target = await this.target(manager, work)
    return !!target && target.box.desiredState !== BoxDesiredState.DESTROYED
  }

  private async target(manager: EntityManager, { job, payload, checkpoint }: Work) {
    const restore = payload.restore
    if (!restore || job.resourceId !== restore.targetBoxId) return null
    const box = await manager.findOne(Box, {
      where: { id: job.resourceId, organizationId: checkpoint.organizationId },
      lock: { mode: 'pessimistic_write' },
    })
    const state = await manager.findOne(BoxCheckpointState, {
      where: { boxId: job.resourceId },
      lock: { mode: 'pessimistic_write' },
    })
    const operation = await manager.findOne(CheckpointOperation, {
      where: { id: restore.operationId, jobId: job.id, state: 'pending' },
      lock: { mode: 'pessimistic_write' },
    })
    if (
      !box ||
      !state ||
      !operation ||
      box.runnerId !== job.runnerId ||
      state.activeJobId !== job.id ||
      state.sequence !== restore.targetSequence ||
      operation.checkpointId !== checkpoint.id ||
      operation.boxId !== box.id ||
      operation.runnerId !== job.runnerId
    )
      return null
    return { box, state, operation }
  }

  private async workerWork(manager: EntityManager, worker: Worker, id: string) {
    const enrollment = await checkpointEnrollment(manager, worker.runner.runnerId, worker)
    if (!enrollment) throw new ForbiddenException('Runner has no protected checkpoint lease')
    const work = await this.work(manager, await this.lockJob(manager, id, worker.runner.runnerId))
    if (!ownsProtectedCheckpoint(work.payload, enrollment))
      throw new ForbiddenException('Protected checkpoint is owned by another lease')
    return work
  }

  private async leaseIsActive(manager: EntityManager, { job, payload }: Work): Promise<boolean> {
    // The shared floor lock orders lease revocation with work. Read the database clock after waiting for work locks.
    const [row] = await manager.query(
      `SELECT EXISTS (SELECT 1 FROM complete_outbound_runner_enrollment
        WHERE runner_id = $1 AND lease_id = $2 AND expires_at > clock_timestamp()
          AND protected_checkpoint_retirement IS NULL) AS active`,
      [job.runnerId, payload.lease_id],
    )
    return row.active
  }

  private async lockJob(manager: EntityManager, id: string, runnerId: string): Promise<Job> {
    const job = await manager.findOne(Job, {
      where: { id, runnerId, type: In(PROTECTED_CHECKPOINT_JOB_TYPES) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!job) throw new ConflictException('Protected checkpoint job is unavailable')
    return job
  }

  private async work(manager: EntityManager, job: Job): Promise<Work> {
    const payload = job.getPayload<ProtectedCheckpointPayload>()
    if (!payload?.checkpointId || !validCompleteOutboundSnapshot(payload.captureOutbound))
      throw new ConflictException('Protected checkpoint payload is incomplete')
    const checkpoint = await manager.findOne(Checkpoint, {
      where: { id: payload.checkpointId },
      lock: { mode: 'pessimistic_write' },
    })
    if (
      !checkpoint?.captureOutbound ||
      !sameCompleteOutboundSnapshot(checkpoint.captureOutbound, payload.captureOutbound) ||
      checkpoint.arcPath !== payload.arcPath ||
      (job.type !== JobType.IMPORT_PROTECTED_CHECKPOINT && checkpoint.sourceRunnerId !== job.runnerId)
    ) {
      throw new ConflictException('Protected checkpoint job does not own the capture')
    }
    return { job, payload, checkpoint }
  }

  private worker(runner: RunnerContext, token: string | undefined): Worker {
    if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
      throw new ForbiddenException('Protected checkpoint lease is required')
    return { runner, token }
  }

  private async allowUpdates(manager: EntityManager): Promise<void> {
    await manager.query("SELECT set_config('boxlite.protected_checkpoint_transition', 'on', true)")
  }

  private publish(change: Change | undefined): void {
    if (!change) return
    this.cache.invalidate(change.box)
    if (change.box.state !== change.previous)
      this.events.emit(BoxEvents.STATE_UPDATED, new BoxStateUpdatedEvent(change.box, change.previous, change.box.state))
  }
}

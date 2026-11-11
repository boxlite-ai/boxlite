// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Injectable, Logger, Optional } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Cron, CronExpression } from '@nestjs/schedule'
import { DataSource } from 'typeorm'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { Checkpoint, CheckpointArchive } from '../entities/checkpoint.entity'
import { Job } from '../entities/job.entity'
import { Box } from '../entities/box.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { runnerJobQueueKey } from '../constants/runner-job-queue'
import { recordBoxJobOutcome } from '../utils/box-business-event.util'

export function isCheckpointJobType(type: JobType): boolean {
  return type === JobType.EXPORT_CHECKPOINT || type === JobType.UPLOAD_CHECKPOINT || type === JobType.IMPORT_CHECKPOINT
}

@Injectable()
export class CheckpointJobReceiver {
  private readonly logger = new Logger(CheckpointJobReceiver.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly cache: BoxLookupCacheInvalidationService,
    @Optional() private readonly events: EventEmitter2,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async handleJobCompletion(notification: Job): Promise<void> {
    if (notification.type === JobType.IMPORT_CHECKPOINT) {
      await this.handleImportCompletion(notification.id)
      return
    }
    let source: Box | null = null
    let queuedUpload: Job | null = null
    await this.dataSource.transaction(async (manager) => {
      // The persisted job is authoritative. A delayed caller must not replace
      // current terminal metadata or advance a different checkpoint operation.
      const job = await manager.findOneBy(Job, { id: notification.id })
      if (!job || !isCheckpointJobType(job.type) || ![JobStatus.COMPLETED, JobStatus.FAILED].includes(job.status))
        return
      const checkpoint = await manager.findOne(Checkpoint, {
        where: { activeJobId: job.id, state: 'creating' },
        lock: { mode: 'pessimistic_write' },
      })
      if (!checkpoint || job.runnerId !== checkpoint.sourceRunnerId) return
      const exporting = job.type === JobType.EXPORT_CHECKPOINT
      if (exporting) {
        if (
          job.resourceType !== ResourceType.BOX ||
          job.resourceId !== checkpoint.sourceBoxId ||
          checkpoint.exportJobId !== job.id
        )
          return
        source = await manager.findOne(Box, {
          where: { id: checkpoint.sourceBoxId },
          lock: { mode: 'pessimistic_write' },
        })
        if (source) {
          const checkpointState = await manager.findOne(BoxCheckpointState, {
            where: { boxId: source.id },
            lock: { mode: 'pessimistic_write' },
          })
          if (checkpointState?.activeJobId === job.id) {
            const unchanged =
              source.state === checkpoint.sourceState && String(source.desiredState) === String(checkpoint.sourceState)
            checkpointState.activeJobId = null
            await manager.save(BoxCheckpointState, checkpointState)
            if (unchanged) await manager.update(Box, { id: source.id }, { pending: false })
          }
        }
      } else if (job.resourceType !== ResourceType.CHECKPOINT || job.resourceId !== checkpoint.id) return

      const archive = validateArchive(job.getResultMetadata(), checkpoint)
      const unchangedArchive =
        archive &&
        checkpoint.archive &&
        archive.sizeBytes === checkpoint.archive.sizeBytes &&
        archive.sha256 === checkpoint.archive.sha256 &&
        archive.pinnedImage === checkpoint.archive.pinnedImage
      if (job.status === JobStatus.FAILED || !archive || (!exporting && !unchangedArchive)) {
        checkpoint.state = 'failed'
        checkpoint.activeJobId = null
        checkpoint.errorReason =
          job.status === JobStatus.FAILED
            ? `Checkpoint ${exporting ? 'export' : 'upload'} failed`
            : 'Checkpoint job returned invalid archive metadata'
        await manager.save(Checkpoint, checkpoint)
        return
      }
      if (exporting) {
        checkpoint.archive = archive
        const upload = new Job({
          type: JobType.UPLOAD_CHECKPOINT,
          runnerId: checkpoint.sourceRunnerId,
          resourceType: ResourceType.CHECKPOINT,
          resourceId: checkpoint.id,
          payload: JSON.stringify(archive),
        })
        await manager.insert(Job, upload)
        checkpoint.activeJobId = upload.id
        queuedUpload = upload
      } else {
        checkpoint.state = 'ready'
        checkpoint.activeJobId = null
      }
      await manager.save(Checkpoint, checkpoint)
    })
    if (queuedUpload) {
      try {
        await this.redis.lpush(runnerJobQueueKey(queuedUpload.runnerId), queuedUpload.id)
      } catch (error) {
        // The committed job remains discoverable by fallback polling.
        this.logger.warn(`Failed to notify runner about checkpoint upload ${queuedUpload.id}: ${error.message}`)
      }
    }
    if (source) this.cache.invalidate(source)
  }

  /** Commit only the owned import receipt; report its logical outcome after commit. */
  private async handleImportCompletion(jobId: string): Promise<void> {
    const changed = await this.dataSource.transaction(async (manager) => {
      const job = await manager.findOneBy(Job, { id: jobId, type: JobType.IMPORT_CHECKPOINT })
      if (!job || ![JobStatus.COMPLETED, JobStatus.FAILED].includes(job.status)) return
      const selected = await manager.findOneBy(CheckpointOperation, { jobId, state: 'pending' })
      if (!selected) return
      // Match admission/deletion: checkpoint, target, coordination, operation.
      const checkpoint = await manager.findOne(Checkpoint, {
        where: { id: selected.checkpointId, organizationId: selected.organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!checkpoint || checkpoint.state !== 'ready') return
      const box = await manager.findOne(Box, {
        where: { id: selected.boxId, organizationId: selected.organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      const checkpointState = await manager.findOne(BoxCheckpointState, {
        where: { boxId: selected.boxId },
        lock: { mode: 'pessimistic_write' },
      })
      const operation = await manager.findOne(CheckpointOperation, {
        where: { id: selected.id, jobId, state: 'pending' },
        lock: { mode: 'pessimistic_write' },
      })
      if (
        !operation ||
        !box ||
        !checkpointState ||
        checkpointState.activeJobId !== job.id ||
        checkpointState.sequence !== operation.sequence ||
        box.runnerId !== operation.runnerId ||
        job.runnerId !== operation.runnerId ||
        job.resourceType !== ResourceType.BOX ||
        job.resourceId !== box.id
      )
        return
      if (box.desiredState === BoxDesiredState.DESTROYED) {
        operation.state = 'cancelled'
        await manager.save(CheckpointOperation, operation)
        return
      }
      const result = job.getResultMetadata()
      const accepted =
        job.status === JobStatus.COMPLETED &&
        result?.operationId === operation.id &&
        result?.targetSequence === operation.sequence &&
        typeof result?.nativeId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(result.nativeId)
      const previousState = box.state
      if (accepted) {
        checkpointState.activeJobId = null
        await manager.save(BoxCheckpointState, checkpointState)
        Object.assign(box, operation.environment, {
          state: BoxState.STOPPED,
          pending: false,
          errorReason: null,
          recoverable: false,
        })
        box.assertValid()
        box.enforceInvariants()
        operation.state = 'completed'
        operation.nativeId = result.nativeId as string
        operation.errorReason = null
      } else {
        // Keep the use reservation and ownership until the Box is deleted.
        operation.state = 'failed'
        operation.errorReason = 'Checkpoint import failed; delete the Box and create another from the checkpoint'
        box.state = BoxState.ERROR
        box.errorReason = operation.errorReason
        box.recoverable = false
      }
      await manager.save(Box, box)
      await manager.save(CheckpointOperation, operation)
      return { box, previousState, outcome: accepted ? JobStatus.COMPLETED : JobStatus.FAILED }
    })
    if (changed) {
      recordBoxJobOutcome('box.create', changed.outcome, changed.box)
      this.cache.invalidate(changed.box)
      if (changed.previousState !== changed.box.state)
        this.events?.emit(
          BoxEvents.STATE_UPDATED,
          new BoxStateUpdatedEvent(changed.box, changed.previousState, changed.box.state),
        )
    }
  }

  // JobService persists terminal status before delivering its callback. Replay
  // those durable results after a lost callback or API restart; ownership
  // changes in the transaction make concurrent cron/callback delivery harmless.
  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'checkpoint-job-reconciliation' })
  async reconcile(): Promise<void> {
    const jobs = await this.dataSource
      .getRepository(Job)
      .createQueryBuilder('job')
      .leftJoin(Checkpoint, 'checkpoint', 'checkpoint."activeJobId" = job.id')
      .leftJoin(CheckpointOperation, 'operation', 'operation."jobId" = job.id')
      .where('(checkpoint.state = :captureState OR operation.state = :useState)', {
        captureState: 'creating',
        useState: 'pending',
      })
      .andWhere('job.status IN (:...statuses)', { statuses: [JobStatus.COMPLETED, JobStatus.FAILED] })
      .orderBy('job.completedAt', 'ASC')
      .limit(100)
      .getMany()
    for (const job of jobs) {
      try {
        await this.handleJobCompletion(job)
      } catch (error) {
        this.logger.error(`Could not reconcile checkpoint job ${job.id}`, error)
      }
    }
  }
}

function validateArchive(value: Record<string, unknown> | null, checkpoint: Checkpoint): CheckpointArchive | null {
  if (
    !checkpoint.exportJobId ||
    !value ||
    value.checkpointId !== checkpoint.id ||
    value.exportJobId !== checkpoint.exportJobId ||
    value.sourceBoxId !== checkpoint.sourceBoxId ||
    value.arcPath !== checkpoint.arcPath ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.pinnedImage !== 'string' ||
    !/^.+@sha256:[0-9a-f]{64}$/.test(value.pinnedImage)
  )
    return null
  return {
    checkpointId: checkpoint.id,
    exportJobId: checkpoint.exportJobId,
    sourceBoxId: checkpoint.sourceBoxId,
    arcPath: checkpoint.arcPath,
    sizeBytes: value.sizeBytes as number,
    sha256: value.sha256,
    pinnedImage: value.pinnedImage,
  }
}

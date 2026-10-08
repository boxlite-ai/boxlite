/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { Job } from '../entities/job.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { recordBusinessEvent } from '../../common/utils/business-event.util'
import { BoxRepository } from '../repositories/box.repository'
import { Box } from '../entities/box.entity'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { ResourceType } from '../enums/resource-type.enum'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { BoxMigrationJobReceiver, isMigrationJobType } from './box-migration-job-receiver.service'

/**
 * Service for handling entity state updates based on job completion (v2 runners only).
 * This service listens to job status changes and updates entity states accordingly.
 */
@Injectable()
export class JobStateHandlerService {
  private readonly logger = new Logger(JobStateHandlerService.name)

  constructor(
    private readonly boxRepository: BoxRepository,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly boxMigrationJobReceiver: BoxMigrationJobReceiver,
  ) {}

  /**
   * Handle job completion and update entity state accordingly.
   * Called when a job status is updated to COMPLETED or FAILED.
   */
  async handleJobCompletion(job: Job): Promise<void> {
    if (job.status !== JobStatus.COMPLETED && job.status !== JobStatus.FAILED) {
      return
    }

    if (!job.resourceId) {
      return
    }

    // A migration job carries its own lock — taken by the loop that submitted
    // it, released by the receiver below — and never the box's state-change
    // lock. Handing it to the tail of this method would delete a lock a
    // concurrent start or stop of the same box is holding.
    if (isMigrationJobType(job.type)) {
      await this.boxMigrationJobReceiver.handleJobCompletion(job)
      return
    }

    switch (job.type) {
      case JobType.CREATE_BOX:
        await this.handleCreateBoxJobCompletion(job)
        break
      case JobType.START_BOX:
        await this.handleStartBoxJobCompletion(job)
        break
      case JobType.STOP_BOX:
        await this.handleStopBoxJobCompletion(job)
        break
      case JobType.DESTROY_BOX:
        await this.handleDestroyBoxJobCompletion(job)
        break
      default:
        break
    }

    switch (job.resourceType) {
      case ResourceType.BOX: {
        const lockKey = getStateChangeLockKey(job.resourceId)
        this.redisLockProvider
          .unlock(lockKey)
          .catch((error) => this.logger.error(`Error unlocking Redis lock for box ${job.resourceId}:`, error)) // Clean up lock after job completion
        break
      }
      default:
        break
    }
  }

  private async handleCreateBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for CREATE_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for CREATE_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        return
      }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`CREATE_BOX job ${job.id} completed successfully, marking box ${boxId} as STARTED`)
        updateData.state = BoxState.STARTED
        updateData.errorReason = null
        const metadata = job.getResultMetadata()
        if (metadata?.daemonVersion && typeof metadata.daemonVersion === 'string') {
          updateData.daemonVersion = metadata.daemonVersion
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`CREATE_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
        updateData.state = BoxState.ERROR
        const { recoverable, errorReason } = sanitizeBoxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to create box'
        updateData.recoverable = recoverable
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
      // Warm-pool top-up creates stock no one requested; the claim records
      // that box's box.create pair instead (BoxService.assignWarmPoolBox).
      if (box.organizationId !== BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
        this.recordJobOutcome('box.create', job, box)
      }
    } catch (error) {
      this.logger.error(`Error handling CREATE_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handleStartBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for START_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for START_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        return
      }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`START_BOX job ${job.id} completed successfully, marking box ${boxId} as STARTED`)
        updateData.state = BoxState.STARTED
        updateData.errorReason = null
        const metadata = job.getResultMetadata()
        if (metadata?.daemonVersion && typeof metadata.daemonVersion === 'string') {
          updateData.daemonVersion = metadata.daemonVersion
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`START_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
        updateData.state = BoxState.ERROR
        const { recoverable, errorReason } = sanitizeBoxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to start box'
        updateData.recoverable = recoverable
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling START_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handleStopBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for STOP_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STOPPED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STOPPED for STOP_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        return
      }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`STOP_BOX job ${job.id} completed successfully, marking box ${boxId} as STOPPED`)
        updateData.state = BoxState.STOPPED
        updateData.errorReason = null
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`STOP_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
        updateData.state = BoxState.ERROR
        const { recoverable, errorReason } = sanitizeBoxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to stop box'
        updateData.recoverable = recoverable
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
      this.recordJobOutcome('box.stop', job, box)
    } catch (error) {
      this.logger.error(`Error handling STOP_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handleDestroyBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for DESTROY_BOX job ${job.id}`)
        return
      }
      const updateData: Partial<Box> = {}

      if (box.desiredState === BoxDesiredState.DESTROYED) {
        if (job.status === JobStatus.COMPLETED) {
          this.logger.debug(`DESTROY_BOX job ${job.id} completed successfully, marking box ${boxId} as DESTROYED`)
          updateData.state = BoxState.DESTROYED
          updateData.errorReason = null
        } else if (job.status === JobStatus.FAILED) {
          this.logger.error(`DESTROY_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
          updateData.state = BoxState.ERROR
          const { recoverable, errorReason } = sanitizeBoxError(job.errorMessage)
          updateData.errorReason = errorReason || 'Failed to destroy box'
          updateData.recoverable = recoverable
        }
      } else {
        return
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
      this.recordJobOutcome('box.delete', job, box)
    } catch (error) {
      this.logger.error(`Error handling DESTROY_BOX job completion for box ${boxId}:`, error)
    }
  }

  /**
   * Records the business outcome of a finished box job. Called only after the
   * box row reflecting that outcome has been written, and only for COMPLETED
   * or FAILED jobs (handleJobCompletion returns early on anything else).
   */
  private recordJobOutcome(name: 'box.create' | 'box.stop' | 'box.delete', job: Job, box: Box): void {
    const event = { name, correlationId: box.id, orgId: box.organizationId } as const
    if (job.status === JobStatus.COMPLETED) {
      recordBusinessEvent({ ...event, outcome: 'success' })
      return
    }
    recordBusinessEvent({ ...event, outcome: 'exception', exceptionType: 'runner_job_failed' })
  }
}

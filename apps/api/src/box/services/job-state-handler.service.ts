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
import { BoxRepository } from '../repositories/box.repository'
import { Box } from '../entities/box.entity'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { ResourceType } from '../enums/resource-type.enum'
import { getStateChangeLockKey } from '../utils/lock-key.util'

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
      case JobType.RESIZE_BOX:
        await this.handleResizeBoxJobCompletion(job)
        break
      // TODO(image-rewrite): PULL_IMAGE / REMOVE_IMAGE job handling removed with
      // the runner image subsystems; rebuild artifact lifecycle handling here.
      case JobType.RECOVER_BOX:
        await this.handleRecoverBoxJobCompletion(job)
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
    } catch (error) {
      this.logger.error(`Error handling DESTROY_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handleRecoverBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for RECOVER_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for RECOVER_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        return
      }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`RECOVER_BOX job ${job.id} completed successfully, marking box ${boxId} as STARTED`)
        updateData.state = BoxState.STARTED
        updateData.errorReason = null
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RECOVER_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
        updateData.state = BoxState.ERROR
        updateData.errorReason = job.errorMessage || 'Failed to recover box'
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling RECOVER_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handleResizeBoxJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for RESIZE_BOX job ${job.id}`)
        return
      }

      if (box.state !== BoxState.RESIZING) {
        this.logger.warn(`Box ${boxId} is not in RESIZING state for RESIZE_BOX job ${job.id}. State: ${box.state}`)
        return
      }

      // Determine the previous state (STARTED or STOPPED based on desiredState)
      const previousState =
        box.desiredState === BoxDesiredState.STARTED
          ? BoxState.STARTED
          : box.desiredState === BoxDesiredState.STOPPED
            ? BoxState.STOPPED
            : null

      if (!previousState) {
        this.logger.error(`Box ${boxId} has unexpected desiredState ${box.desiredState} for RESIZE_BOX job ${job.id}`)
        return
      }

      const payload = job.payload as { cpu?: number; memory?: number; disk?: number }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`RESIZE_BOX job ${job.id} completed successfully for box ${boxId}`)

        // Update box resources
        updateData.cpu = payload.cpu ?? box.cpu
        updateData.mem = payload.memory ?? box.mem
        updateData.disk = payload.disk ?? box.disk
        updateData.state = previousState
        return
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RESIZE_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)

        updateData.state = previousState
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling RESIZE_BOX job completion for box ${boxId}:`, error)
    }
  }
}

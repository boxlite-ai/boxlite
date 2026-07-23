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
import { ResourceType } from '../enums/resource-type.enum'
import { isBoxLifecycleJobType } from '../constants/box-lifecycle-job-types.constant'
import { BoxConflictError } from '../errors/box-conflict.error'

/**
 * Service for handling entity state updates based on job completion (v2 runners only).
 * This service listens to job status changes and updates entity states accordingly.
 */
@Injectable()
export class JobStateHandlerService {
  private readonly logger = new Logger(JobStateHandlerService.name)

  constructor(private readonly boxRepository: BoxRepository) {}

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

    let lifecycleBox: Box | undefined
    if (job.resourceType === ResourceType.BOX && isBoxLifecycleJobType(job.type)) {
      lifecycleBox = (await this.boxRepository.findOne({ where: { id: job.resourceId } })) ?? undefined
      if (!lifecycleBox || lifecycleBox.lifecycleJobId !== job.id) {
        this.logger.debug(
          `Ignoring stale lifecycle job ${job.id} for Box ${job.resourceId}; current job is ${lifecycleBox?.lifecycleJobId ?? 'none'}`,
        )
        return
      }
    }

    try {
      switch (job.type) {
        case JobType.CREATE_BOX:
          await this.handleCreateBoxJobCompletion(job, lifecycleBox)
          break
        case JobType.START_BOX:
          await this.handleStartBoxJobCompletion(job, lifecycleBox)
          break
        case JobType.STOP_BOX:
          await this.handleStopBoxJobCompletion(job, lifecycleBox)
          break
        case JobType.DESTROY_BOX:
          await this.handleDestroyBoxJobCompletion(job, lifecycleBox)
          break
        case JobType.RESIZE_BOX:
          await this.handleResizeBoxJobCompletion(job, lifecycleBox)
          break
        // TODO(image-rewrite): PULL_IMAGE / REMOVE_IMAGE job handling removed with
        // the runner image subsystems; rebuild artifact lifecycle handling here.
        case JobType.RECOVER_BOX:
          await this.handleRecoverBoxJobCompletion(job, lifecycleBox)
          break
        default:
          break
      }
    } catch (error) {
      if (!(error instanceof BoxConflictError) || !lifecycleBox) {
        throw error
      }

      const currentBox = await this.boxRepository.findOne({ where: { id: lifecycleBox.id } })
      if (currentBox?.lifecycleJobId === job.id) {
        throw error
      }

      this.logger.debug(
        `Lifecycle job ${job.id} for Box ${lifecycleBox.id} was completed or superseded concurrently; treating the callback as an idempotent replay`,
      )
      return
    }
  }

  private async handleCreateBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for CREATE_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for CREATE_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        await this.applyLifecycleUpdate(job, box, {})
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

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling CREATE_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async handleStartBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for START_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for START_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        await this.applyLifecycleUpdate(job, box, {})
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

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling START_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async handleStopBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for STOP_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STOPPED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STOPPED for STOP_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        await this.applyLifecycleUpdate(job, box, {})
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

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling STOP_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async handleDestroyBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
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
        await this.applyLifecycleUpdate(job, box, {})
        return
      }

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling DESTROY_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async handleRecoverBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for RECOVER_BOX job ${job.id}`)
        return
      }

      if (box.desiredState !== BoxDesiredState.STARTED) {
        this.logger.error(
          `Box ${boxId} is not in desired state STARTED for RECOVER_BOX job ${job.id}. Desired state: ${box.desiredState}`,
        )
        await this.applyLifecycleUpdate(job, box, {})
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

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling RECOVER_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async handleResizeBoxJobCompletion(job: Job, currentBox?: Box): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = currentBox ?? (await this.boxRepository.findOne({ where: { id: boxId } }))
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for RESIZE_BOX job ${job.id}`)
        return
      }

      if (box.state !== BoxState.RESIZING) {
        this.logger.warn(`Box ${boxId} is not in RESIZING state for RESIZE_BOX job ${job.id}. State: ${box.state}`)
        await this.applyLifecycleUpdate(job, box, {})
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
        await this.applyLifecycleUpdate(job, box, {})
        return
      }

      const payload = job.getPayload<{ cpu?: number; memory?: number; disk?: number }>() ?? {}

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`RESIZE_BOX job ${job.id} completed successfully for box ${boxId}`)

        // Update box resources
        updateData.cpu = payload.cpu ?? box.cpu
        updateData.mem = payload.memory ?? box.mem
        updateData.disk = payload.disk ?? box.disk
        updateData.state = previousState
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RESIZE_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)

        updateData.state = previousState
      }

      await this.applyLifecycleUpdate(job, box, updateData)
    } catch (error) {
      if (!(error instanceof BoxConflictError)) {
        this.logger.error(`Error handling RESIZE_BOX job completion for box ${boxId}:`, error)
      }
      throw error
    }
  }

  private async applyLifecycleUpdate(job: Job, box: Box, updateData: Partial<Box>): Promise<void> {
    if (box.lifecycleJobId !== job.id) {
      throw new Error(`Lifecycle job ${job.id} no longer owns Box ${box.id}`)
    }
    await this.boxRepository.update(box.id, {
      updateData: { ...updateData, lifecycleJobId: null },
      entity: box,
    })
  }
}

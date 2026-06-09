/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Snapshot } from '../entities/snapshot.entity'
import { SnapshotRunner } from '../entities/snapshot-runner.entity'
import { BoxState } from '../enums/box-state.enum'
import { SnapshotState } from '../enums/snapshot-state.enum'
import { SnapshotRunnerState } from '../enums/snapshot-runner-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { Job } from '../entities/job.entity'
import { BackupState } from '../enums/backup-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { sanitizeBoxError } from '../utils/sanitize-error.util'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
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
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(SnapshotRunner)
    private readonly snapshotRunnerRepository: Repository<SnapshotRunner>,
    private readonly organizationUsageService: OrganizationUsageService,
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
      case JobType.PULL_SNAPSHOT:
        await this.handlePullSnapshotJobCompletion(job)
        break
      case JobType.BUILD_SNAPSHOT:
        await this.handleBuildSnapshotJobCompletion(job)
        break
      case JobType.REMOVE_SNAPSHOT:
        await this.handleRemoveSnapshotJobCompletion(job)
        break
      case JobType.CREATE_BACKUP:
        await this.handleCreateBackupJobCompletion(job)
        break
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
        Object.assign(updateData, Box.getBackupStateUpdate(box, BackupState.NONE))
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
      } else if (box.desiredState === BoxDesiredState.ARCHIVED && box.backupState === BackupState.COMPLETED) {
        if (job.status === JobStatus.COMPLETED) {
          this.logger.debug(`DESTROY_BOX job ${job.id} completed during archiving, marking box ${boxId} as ARCHIVED`)
        } else if (job.status === JobStatus.FAILED) {
          this.logger.warn(
            `DESTROY_BOX job ${job.id} failed during archiving for box ${boxId}: ${job.errorMessage}. Marking as ARCHIVED since backup is complete.`,
          )
        }
        updateData.state = BoxState.ARCHIVED
        updateData.errorReason = null
      } else {
        return
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling DESTROY_BOX job completion for box ${boxId}:`, error)
    }
  }

  private async handlePullSnapshotJobCompletion(job: Job): Promise<void> {
    const snapshotRef = job.resourceId
    const runnerId = job.runnerId
    if (!snapshotRef || !runnerId) return

    try {
      const snapshotRunner = await this.snapshotRunnerRepository.findOne({
        where: { snapshotRef, runnerId },
      })

      if (!snapshotRunner) {
        this.logger.warn(`SnapshotRunner not found for snapshot ${snapshotRef} on runner ${runnerId}`)
        return
      }

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `PULL_SNAPSHOT job ${job.id} completed successfully, marking SnapshotRunner ${snapshotRunner.id} as READY`,
        )
        snapshotRunner.state = SnapshotRunnerState.READY
        snapshotRunner.errorReason = null

        // Check if this is the initial runner for a snapshot and update the snapshot state
        const snapshot = await this.snapshotRepository.findOne({
          where: { initialRunnerId: runnerId, ref: snapshotRef },
        })
        if (snapshot && (snapshot.state === SnapshotState.PULLING || snapshot.state === SnapshotState.BUILDING)) {
          this.logger.debug(`Marking snapshot ${snapshot.id} as ACTIVE after initial pull completed`)
          snapshot.state = SnapshotState.ACTIVE
          snapshot.errorReason = null
          snapshot.lastUsedAt = new Date()
          await this.snapshotRepository.save(snapshot)
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`PULL_SNAPSHOT job ${job.id} failed for snapshot ${snapshotRef}: ${job.errorMessage}`)
        snapshotRunner.state = SnapshotRunnerState.ERROR
        snapshotRunner.errorReason = job.errorMessage || 'Failed to pull snapshot'

        // Check if this is the initial runner for a snapshot and update the snapshot state
        const snapshot = await this.snapshotRepository.findOne({
          where: { initialRunnerId: runnerId, ref: snapshotRef },
        })
        if (snapshot && snapshot.state === SnapshotState.PULLING) {
          this.logger.error(`Marking snapshot ${snapshot.id} as ERROR after initial pull failed`)
          snapshot.state = SnapshotState.ERROR
          snapshot.errorReason = job.errorMessage || 'Failed to pull snapshot on initial runner'
          await this.snapshotRepository.save(snapshot)
        }
      }

      await this.snapshotRunnerRepository.save(snapshotRunner)
    } catch (error) {
      this.logger.error(`Error handling PULL_SNAPSHOT job completion for snapshot ${snapshotRef}:`, error)
    }
  }

  private async handleBuildSnapshotJobCompletion(job: Job): Promise<void> {
    const snapshotRef = job.resourceId
    const runnerId = job.runnerId
    if (!snapshotRef || !runnerId) return

    try {
      // For BUILD_SNAPSHOT, find snapshot by buildInfo.snapshotRef
      const snapshot = await this.snapshotRepository
        .createQueryBuilder('snapshot')
        .leftJoinAndSelect('snapshot.buildInfo', 'buildInfo')
        .where('snapshot.initialRunnerId = :runnerId', { runnerId })
        .andWhere('buildInfo.snapshotRef = :snapshotRef', { snapshotRef })
        .getOne()

      // Update SnapshotRunner state
      const snapshotRunner = await this.snapshotRunnerRepository.findOne({
        where: { snapshotRef, runnerId },
      })

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`BUILD_SNAPSHOT job ${job.id} completed successfully for snapshot ref ${snapshotRef}`)

        if (snapshot?.state === SnapshotState.BUILDING) {
          snapshot.state = SnapshotState.ACTIVE
          snapshot.errorReason = null
          snapshot.lastUsedAt = new Date()
          await this.snapshotRepository.save(snapshot)
          this.logger.debug(`Marked snapshot ${snapshot.id} as ACTIVE after build completed`)
        }

        if (snapshotRunner) {
          snapshotRunner.state = SnapshotRunnerState.READY
          snapshotRunner.errorReason = null
          await this.snapshotRunnerRepository.save(snapshotRunner)
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`BUILD_SNAPSHOT job ${job.id} failed for snapshot ref ${snapshotRef}: ${job.errorMessage}`)

        if (snapshot?.state === SnapshotState.BUILDING) {
          snapshot.state = SnapshotState.ERROR
          snapshot.errorReason = job.errorMessage || 'Failed to build snapshot'
          await this.snapshotRepository.save(snapshot)
        }

        if (snapshotRunner) {
          snapshotRunner.state = SnapshotRunnerState.ERROR
          snapshotRunner.errorReason = job.errorMessage || 'Failed to build snapshot'
          await this.snapshotRunnerRepository.save(snapshotRunner)
        }
      }
    } catch (error) {
      this.logger.error(`Error handling BUILD_SNAPSHOT job completion for snapshot ref ${snapshotRef}:`, error)
    }
  }

  private async handleRemoveSnapshotJobCompletion(job: Job): Promise<void> {
    const snapshotRef = job.resourceId
    const runnerId = job.runnerId
    if (!snapshotRef || !runnerId) return

    try {
      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `REMOVE_SNAPSHOT job ${job.id} completed successfully for snapshot ${snapshotRef} on runner ${runnerId}`,
        )
        const affected = await this.snapshotRunnerRepository.delete({ snapshotRef, runnerId })
        if (affected.affected && affected.affected > 0) {
          this.logger.debug(
            `Removed ${affected.affected} snapshot runners for snapshot ${snapshotRef} on runner ${runnerId}`,
          )
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(
          `REMOVE_SNAPSHOT job ${job.id} failed for snapshot ${snapshotRef} on runner ${runnerId}: ${job.errorMessage}`,
        )
      }
    } catch (error) {
      this.logger.error(`Error handling REMOVE_SNAPSHOT job completion for snapshot ${snapshotRef}:`, error)
    }
  }

  private async handleCreateBackupJobCompletion(job: Job): Promise<void> {
    const boxId = job.resourceId
    if (!boxId) return

    try {
      const box = await this.boxRepository.findOne({ where: { id: boxId } })
      if (!box) {
        this.logger.warn(`Box ${boxId} not found for CREATE_BACKUP job ${job.id}`)
        return
      }

      // Parse the job payload to get the snapshot this job was for.
      // Old v2 runners may not include snapshot in the payload, so we only
      // perform stale-snapshot checks when the field is present.
      const jobSnapshot = job.getPayload<{ snapshot?: string }>()?.snapshot

      // Ignore stale backup results if the job's snapshot doesn't match the current DB snapshot.
      // Old v2 runners may not include snapshot in the payload — skip this check for them.
      if (jobSnapshot && jobSnapshot !== box.backupSnapshot) {
        this.logger.warn(
          `Ignoring stale backup ${job.status} for box ${boxId}: job snapshot ${jobSnapshot} does not match DB snapshot ${box.backupSnapshot}`,
        )
        return
      }

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `CREATE_BACKUP job ${job.id} completed successfully, marking box ${boxId} as BACKUP_COMPLETED`,
        )
        Object.assign(updateData, Box.getBackupStateUpdate(box, BackupState.COMPLETED))
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`CREATE_BACKUP job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)
        Object.assign(
          updateData,
          Box.getBackupStateUpdate(box, BackupState.ERROR, undefined, undefined, job.errorMessage),
        )
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling CREATE_BACKUP job completion for box ${boxId}:`, error)
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

      // Calculate deltas before updating box
      const payload = job.payload as { cpu?: number; memory?: number; disk?: number }

      // For cold resize (previousState === STOPPED), cpu/memory don't affect org quota.
      const isHotResize = previousState === BoxState.STARTED
      const cpuDeltaForQuota = isHotResize ? (payload.cpu ?? box.cpu) - box.cpu : 0
      const memDeltaForQuota = isHotResize ? (payload.memory ?? box.mem) - box.mem : 0
      const diskDeltaForQuota = (payload.disk ?? box.disk) - box.disk // Disk only increases

      const updateData: Partial<Box> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`RESIZE_BOX job ${job.id} completed successfully for box ${boxId}`)

        // Update box resources
        updateData.cpu = payload.cpu ?? box.cpu
        updateData.mem = payload.memory ?? box.mem
        updateData.disk = payload.disk ?? box.disk
        updateData.state = previousState

        // Apply usage change (handles both positive and negative deltas)
        await this.organizationUsageService.applyResizeUsageChange(
          box.organizationId,
          box.region,
          cpuDeltaForQuota,
          memDeltaForQuota,
          diskDeltaForQuota,
        )
        return
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RESIZE_BOX job ${job.id} failed for box ${boxId}: ${job.errorMessage}`)

        // Rollback pending usage (all deltas were tracked, including negative)
        await this.organizationUsageService.decrementPendingBoxUsage(
          box.organizationId,
          box.region,
          cpuDeltaForQuota !== 0 ? cpuDeltaForQuota : undefined,
          memDeltaForQuota !== 0 ? memDeltaForQuota : undefined,
          diskDeltaForQuota !== 0 ? diskDeltaForQuota : undefined,
        )

        updateData.state = previousState
      }

      await this.boxRepository.update(boxId, { updateData, entity: box })
    } catch (error) {
      this.logger.error(`Error handling RESIZE_BOX job completion for box ${boxId}:`, error)
    }
  }
}

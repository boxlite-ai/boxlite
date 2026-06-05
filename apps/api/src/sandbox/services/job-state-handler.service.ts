/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BoxTemplate } from '../entities/box-template.entity'
import { RunnerArtifactCache } from '../entities/runner-artifact-cache.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { Job } from '../entities/job.entity'
import { BackupState } from '../enums/backup-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { sanitizeSandboxError } from '../utils/sanitize-error.util'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { Sandbox } from '../entities/sandbox.entity'
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
    private readonly sandboxRepository: SandboxRepository,
    @InjectRepository(BoxTemplate)
    private readonly boxTemplateRepository: Repository<BoxTemplate>,
    @InjectRepository(RunnerArtifactCache)
    private readonly runnerArtifactCacheRepository: Repository<RunnerArtifactCache>,
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
      case JobType.CREATE_SANDBOX:
        await this.handleCreateSandboxJobCompletion(job)
        break
      case JobType.START_SANDBOX:
        await this.handleStartSandboxJobCompletion(job)
        break
      case JobType.STOP_SANDBOX:
        await this.handleStopSandboxJobCompletion(job)
        break
      case JobType.DESTROY_SANDBOX:
        await this.handleDestroySandboxJobCompletion(job)
        break
      case JobType.RESIZE_SANDBOX:
        await this.handleResizeSandboxJobCompletion(job)
        break
      case JobType.PULL_ARTIFACT:
        await this.handlePullArtifactJobCompletion(job)
        break
      case JobType.BUILD_ARTIFACT:
        await this.handleBuildArtifactJobCompletion(job)
        break
      case JobType.REMOVE_ARTIFACT:
        await this.handleRemoveArtifactJobCompletion(job)
        break
      case JobType.CREATE_BACKUP:
        await this.handleCreateBackupJobCompletion(job)
        break
      case JobType.RECOVER_SANDBOX:
        await this.handleRecoverSandboxJobCompletion(job)
        break
      default:
        break
    }

    switch (job.resourceType) {
      case ResourceType.SANDBOX: {
        const lockKey = getStateChangeLockKey(job.resourceId)
        this.redisLockProvider
          .unlock(lockKey)
          .catch((error) => this.logger.error(`Error unlocking Redis lock for sandbox ${job.resourceId}:`, error)) // Clean up lock after job completion
        break
      }
      default:
        break
    }
  }

  private async handleCreateSandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for CREATE_SANDBOX job ${job.id}`)
        return
      }

      if (sandbox.desiredState !== SandboxDesiredState.STARTED) {
        this.logger.error(
          `Sandbox ${sandboxId} is not in desired state STARTED for CREATE_SANDBOX job ${job.id}. Desired state: ${sandbox.desiredState}`,
        )
        return
      }

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `CREATE_SANDBOX job ${job.id} completed successfully, marking sandbox ${sandboxId} as STARTED`,
        )
        updateData.state = SandboxState.STARTED
        updateData.errorReason = null
        const metadata = job.getResultMetadata()
        if (metadata?.daemonVersion && typeof metadata.daemonVersion === 'string') {
          updateData.daemonVersion = metadata.daemonVersion
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`CREATE_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
        updateData.state = SandboxState.ERROR
        const { recoverable, errorReason } = sanitizeSandboxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to create sandbox'
        updateData.recoverable = recoverable
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling CREATE_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handleStartSandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for START_SANDBOX job ${job.id}`)
        return
      }

      if (sandbox.desiredState !== SandboxDesiredState.STARTED) {
        this.logger.error(
          `Sandbox ${sandboxId} is not in desired state STARTED for START_SANDBOX job ${job.id}. Desired state: ${sandbox.desiredState}`,
        )
        return
      }

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`START_SANDBOX job ${job.id} completed successfully, marking sandbox ${sandboxId} as STARTED`)
        updateData.state = SandboxState.STARTED
        updateData.errorReason = null
        const metadata = job.getResultMetadata()
        if (metadata?.daemonVersion && typeof metadata.daemonVersion === 'string') {
          updateData.daemonVersion = metadata.daemonVersion
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`START_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
        updateData.state = SandboxState.ERROR
        const { recoverable, errorReason } = sanitizeSandboxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to start sandbox'
        updateData.recoverable = recoverable
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling START_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handleStopSandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for STOP_SANDBOX job ${job.id}`)
        return
      }

      if (sandbox.desiredState !== SandboxDesiredState.STOPPED) {
        this.logger.error(
          `Sandbox ${sandboxId} is not in desired state STOPPED for STOP_SANDBOX job ${job.id}. Desired state: ${sandbox.desiredState}`,
        )
        return
      }

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`STOP_SANDBOX job ${job.id} completed successfully, marking sandbox ${sandboxId} as STOPPED`)
        updateData.state = SandboxState.STOPPED
        updateData.errorReason = null
        Object.assign(updateData, Sandbox.getBackupStateUpdate(sandbox, BackupState.NONE))
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`STOP_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
        updateData.state = SandboxState.ERROR
        const { recoverable, errorReason } = sanitizeSandboxError(job.errorMessage)
        updateData.errorReason = errorReason || 'Failed to stop sandbox'
        updateData.recoverable = recoverable
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling STOP_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handleDestroySandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for DESTROY_SANDBOX job ${job.id}`)
        return
      }
      const updateData: Partial<Sandbox> = {}

      if (sandbox.desiredState === SandboxDesiredState.DESTROYED) {
        if (job.status === JobStatus.COMPLETED) {
          this.logger.debug(
            `DESTROY_SANDBOX job ${job.id} completed successfully, marking sandbox ${sandboxId} as DESTROYED`,
          )
          updateData.state = SandboxState.DESTROYED
          updateData.errorReason = null
        } else if (job.status === JobStatus.FAILED) {
          this.logger.error(`DESTROY_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
          updateData.state = SandboxState.ERROR
          const { recoverable, errorReason } = sanitizeSandboxError(job.errorMessage)
          updateData.errorReason = errorReason || 'Failed to destroy sandbox'
          updateData.recoverable = recoverable
        }
      } else if (
        sandbox.desiredState === SandboxDesiredState.ARCHIVED &&
        sandbox.backupState === BackupState.COMPLETED
      ) {
        if (job.status === JobStatus.COMPLETED) {
          this.logger.debug(
            `DESTROY_SANDBOX job ${job.id} completed during archiving, marking sandbox ${sandboxId} as ARCHIVED`,
          )
        } else if (job.status === JobStatus.FAILED) {
          this.logger.warn(
            `DESTROY_SANDBOX job ${job.id} failed during archiving for sandbox ${sandboxId}: ${job.errorMessage}. Marking as ARCHIVED since backup is complete.`,
          )
        }
        updateData.state = SandboxState.ARCHIVED
        updateData.errorReason = null
      } else {
        return
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling DESTROY_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handlePullArtifactJobCompletion(job: Job): Promise<void> {
    const artifactRef = job.resourceId
    const runnerId = job.runnerId
    if (!artifactRef || !runnerId) return

    try {
      const runnerArtifactCache = await this.runnerArtifactCacheRepository.findOne({
        where: { artifactRef, runnerId },
      })

      if (!runnerArtifactCache) {
        this.logger.warn(`RunnerArtifactCache not found for artifact ${artifactRef} on runner ${runnerId}`)
        return
      }

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `PULL_ARTIFACT job ${job.id} completed successfully, marking RunnerArtifactCache ${runnerArtifactCache.id} as READY`,
        )
        runnerArtifactCache.state = RunnerArtifactCacheState.READY
        runnerArtifactCache.errorReason = null

        // Check if this is the initial runner for a template and update the template state.
        const template = await this.boxTemplateRepository.findOne({
          where: { initialRunnerId: runnerId, artifactRef: artifactRef },
        })
        if (template && (template.state === BoxTemplateState.PULLING || template.state === BoxTemplateState.BUILDING)) {
          this.logger.debug(`Marking template ${template.id} as ACTIVE after initial pull completed`)
          template.state = BoxTemplateState.ACTIVE
          template.errorReason = null
          template.lastUsedAt = new Date()
          await this.boxTemplateRepository.save(template)
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`PULL_ARTIFACT job ${job.id} failed for artifact ${artifactRef}: ${job.errorMessage}`)
        runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
        runnerArtifactCache.errorReason = job.errorMessage || 'Failed to pull artifact'

        // Check if this is the initial runner for a template and update the template state.
        const template = await this.boxTemplateRepository.findOne({
          where: { initialRunnerId: runnerId, artifactRef: artifactRef },
        })
        if (template && template.state === BoxTemplateState.PULLING) {
          this.logger.error(`Marking template ${template.id} as ERROR after initial pull failed`)
          template.state = BoxTemplateState.ERROR
          template.errorReason = job.errorMessage || 'Failed to pull artifact on initial runner'
          await this.boxTemplateRepository.save(template)
        }
      }

      await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
    } catch (error) {
      this.logger.error(`Error handling PULL_ARTIFACT job completion for artifact ${artifactRef}:`, error)
    }
  }

  private async handleBuildArtifactJobCompletion(job: Job): Promise<void> {
    const artifactRef = job.resourceId
    const runnerId = job.runnerId
    if (!artifactRef || !runnerId) return

    try {
      // For BUILD_ARTIFACT, find the template by buildInfo.artifactRef.
      const template = await this.boxTemplateRepository
        .createQueryBuilder('template')
        .leftJoinAndSelect('template.buildInfo', 'buildInfo')
        .where('template.initialRunnerId = :runnerId', { runnerId })
        .andWhere('buildInfo.artifactRef = :artifactRef', { artifactRef })
        .getOne()

      // Update RunnerArtifactCache state
      const runnerArtifactCache = await this.runnerArtifactCacheRepository.findOne({
        where: { artifactRef, runnerId },
      })

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`BUILD_ARTIFACT job ${job.id} completed successfully for artifact ref ${artifactRef}`)

        if (template?.state === BoxTemplateState.BUILDING) {
          template.state = BoxTemplateState.ACTIVE
          template.errorReason = null
          template.lastUsedAt = new Date()
          await this.boxTemplateRepository.save(template)
          this.logger.debug(`Marked template ${template.id} as ACTIVE after build completed`)
        }

        if (runnerArtifactCache) {
          runnerArtifactCache.state = RunnerArtifactCacheState.READY
          runnerArtifactCache.errorReason = null
          await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`BUILD_ARTIFACT job ${job.id} failed for artifact ref ${artifactRef}: ${job.errorMessage}`)

        if (template?.state === BoxTemplateState.BUILDING) {
          template.state = BoxTemplateState.ERROR
          template.errorReason = job.errorMessage || 'Failed to build artifact'
          await this.boxTemplateRepository.save(template)
        }

        if (runnerArtifactCache) {
          runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
          runnerArtifactCache.errorReason = job.errorMessage || 'Failed to build artifact'
          await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
        }
      }
    } catch (error) {
      this.logger.error(`Error handling BUILD_ARTIFACT job completion for artifact ref ${artifactRef}:`, error)
    }
  }

  private async handleRemoveArtifactJobCompletion(job: Job): Promise<void> {
    const artifactRef = job.resourceId
    const runnerId = job.runnerId
    if (!artifactRef || !runnerId) return

    try {
      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `REMOVE_ARTIFACT job ${job.id} completed successfully for artifact ${artifactRef} on runner ${runnerId}`,
        )
        const affected = await this.runnerArtifactCacheRepository.delete({ artifactRef, runnerId })
        if (affected.affected && affected.affected > 0) {
          this.logger.debug(
            `Removed ${affected.affected} runner artifact caches for artifact ${artifactRef} on runner ${runnerId}`,
          )
        }
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(
          `REMOVE_ARTIFACT job ${job.id} failed for artifact ${artifactRef} on runner ${runnerId}: ${job.errorMessage}`,
        )
      }
    } catch (error) {
      this.logger.error(`Error handling REMOVE_ARTIFACT job completion for artifact ${artifactRef}:`, error)
    }
  }

  private async handleCreateBackupJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for CREATE_BACKUP job ${job.id}`)
        return
      }

      // Parse the job payload to get the snapshot this job was for.
      // Old v2 runners may not include snapshot in the payload, so we only
      // perform stale-snapshot checks when the field is present.
      const jobSnapshot = job.getPayload<{ snapshot?: string }>()?.snapshot

      // Ignore stale backup results if the job's snapshot doesn't match the current DB snapshot.
      // Old v2 runners may not include snapshot in the payload — skip this check for them.
      if (jobSnapshot && jobSnapshot !== sandbox.backupSnapshot) {
        this.logger.warn(
          `Ignoring stale backup ${job.status} for sandbox ${sandboxId}: job snapshot ${jobSnapshot} does not match DB snapshot ${sandbox.backupSnapshot}`,
        )
        return
      }

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `CREATE_BACKUP job ${job.id} completed successfully, marking sandbox ${sandboxId} as BACKUP_COMPLETED`,
        )
        Object.assign(updateData, Sandbox.getBackupStateUpdate(sandbox, BackupState.COMPLETED))
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`CREATE_BACKUP job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
        Object.assign(
          updateData,
          Sandbox.getBackupStateUpdate(sandbox, BackupState.ERROR, undefined, undefined, job.errorMessage),
        )
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling CREATE_BACKUP job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handleRecoverSandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for RECOVER_SANDBOX job ${job.id}`)
        return
      }

      if (sandbox.desiredState !== SandboxDesiredState.STARTED) {
        this.logger.error(
          `Sandbox ${sandboxId} is not in desired state STARTED for RECOVER_SANDBOX job ${job.id}. Desired state: ${sandbox.desiredState}`,
        )
        return
      }

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(
          `RECOVER_SANDBOX job ${job.id} completed successfully, marking sandbox ${sandboxId} as STARTED`,
        )
        updateData.state = SandboxState.STARTED
        updateData.errorReason = null
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RECOVER_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)
        updateData.state = SandboxState.ERROR
        updateData.errorReason = job.errorMessage || 'Failed to recover sandbox'
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling RECOVER_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }

  private async handleResizeSandboxJobCompletion(job: Job): Promise<void> {
    const sandboxId = job.resourceId
    if (!sandboxId) return

    try {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) {
        this.logger.warn(`Sandbox ${sandboxId} not found for RESIZE_SANDBOX job ${job.id}`)
        return
      }

      if (sandbox.state !== SandboxState.RESIZING) {
        this.logger.warn(
          `Sandbox ${sandboxId} is not in RESIZING state for RESIZE_SANDBOX job ${job.id}. State: ${sandbox.state}`,
        )
        return
      }

      // Determine the previous state (STARTED or STOPPED based on desiredState)
      const previousState =
        sandbox.desiredState === SandboxDesiredState.STARTED
          ? SandboxState.STARTED
          : sandbox.desiredState === SandboxDesiredState.STOPPED
            ? SandboxState.STOPPED
            : null

      if (!previousState) {
        this.logger.error(
          `Sandbox ${sandboxId} has unexpected desiredState ${sandbox.desiredState} for RESIZE_SANDBOX job ${job.id}`,
        )
        return
      }

      // Calculate deltas before updating sandbox
      const payload = job.payload as { cpu?: number; memory?: number; disk?: number }

      // For cold resize (previousState === STOPPED), cpu/memory don't affect org quota.
      const isHotResize = previousState === SandboxState.STARTED
      const cpuDeltaForQuota = isHotResize ? (payload.cpu ?? sandbox.cpu) - sandbox.cpu : 0
      const memDeltaForQuota = isHotResize ? (payload.memory ?? sandbox.mem) - sandbox.mem : 0
      const diskDeltaForQuota = (payload.disk ?? sandbox.disk) - sandbox.disk // Disk only increases

      const updateData: Partial<Sandbox> = {}

      if (job.status === JobStatus.COMPLETED) {
        this.logger.debug(`RESIZE_SANDBOX job ${job.id} completed successfully for sandbox ${sandboxId}`)

        // Update sandbox resources
        updateData.cpu = payload.cpu ?? sandbox.cpu
        updateData.mem = payload.memory ?? sandbox.mem
        updateData.disk = payload.disk ?? sandbox.disk
        updateData.state = previousState

        // Apply usage change (handles both positive and negative deltas)
        await this.organizationUsageService.applyResizeUsageChange(
          sandbox.organizationId,
          sandbox.region,
          cpuDeltaForQuota,
          memDeltaForQuota,
          diskDeltaForQuota,
        )
        return
      } else if (job.status === JobStatus.FAILED) {
        this.logger.error(`RESIZE_SANDBOX job ${job.id} failed for sandbox ${sandboxId}: ${job.errorMessage}`)

        // Rollback pending usage (all deltas were tracked, including negative)
        await this.organizationUsageService.decrementPendingSandboxUsage(
          sandbox.organizationId,
          sandbox.region,
          cpuDeltaForQuota !== 0 ? cpuDeltaForQuota : undefined,
          memDeltaForQuota !== 0 ? memDeltaForQuota : undefined,
          diskDeltaForQuota !== 0 ? diskDeltaForQuota : undefined,
        )

        updateData.state = previousState
      }

      await this.sandboxRepository.update(sandboxId, { updateData, entity: sandbox })
    } catch (error) {
      this.logger.error(`Error handling RESIZE_SANDBOX job completion for sandbox ${sandboxId}:`, error)
    }
  }
}

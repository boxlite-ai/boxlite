/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { BoxRepository } from '../../repositories/box.repository'
import { RECOVERY_ERROR_SUBSTRINGS } from '../../constants/errors-for-recovery'
import { Box } from '../../entities/box.entity'
import { BoxState } from '../../enums/box-state.enum'
import { DONT_SYNC_AGAIN, BoxAction, SYNC_AGAIN, SyncState } from './box.action'
import { BOX_BUILD_INFO_CACHE_TTL_MS } from '../../utils/box-lookup-cache.util'
import { SnapshotRunnerState } from '../../enums/snapshot-runner-state.enum'
import { BackupState } from '../../enums/backup-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { BuildInfo } from '../../entities/build-info.entity'
import { SnapshotService } from '../../services/snapshot.service'
import { DockerRegistryService } from '../../../docker-registry/services/docker-registry.service'
import { DockerRegistry } from '../../../docker-registry/entities/docker-registry.entity'
import { RunnerService } from '../../services/runner.service'
import { RunnerAdapterFactory } from '../../runner-adapter/runnerAdapter'
import { SnapshotStateError } from '../../errors/snapshot-state-error'
import { Snapshot } from '../../entities/snapshot.entity'
import { OrganizationService } from '../../../organization/services/organization.service'
import { TypedConfigService } from '../../../config/typed-config.service'
import { Runner } from '../../entities/runner.entity'
import { Organization } from '../../../organization/entities/organization.entity'
import { LockCode, RedisLockProvider } from '../../common/redis-lock.provider'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { WithSpan } from '../../../common/decorators/otel.decorator'
import { BoxActivityService } from '../../services/box-activity.service'

@Injectable()
export class BoxStartAction extends BoxAction {
  protected readonly logger = new Logger(BoxStartAction.name)
  constructor(
    protected runnerService: RunnerService,
    protected runnerAdapterFactory: RunnerAdapterFactory,
    protected boxRepository: BoxRepository,
    protected readonly snapshotService: SnapshotService,
    protected readonly dockerRegistryService: DockerRegistryService,
    protected readonly organizationService: OrganizationService,
    protected readonly configService: TypedConfigService,
    protected readonly redisLockProvider: RedisLockProvider,
    @InjectRedis() private readonly redis: Redis,
    private readonly boxActivityService: BoxActivityService,
  ) {
    super(runnerService, runnerAdapterFactory, boxRepository, redisLockProvider)
  }

  @WithSpan()
  async run(box: Box, lockCode: LockCode): Promise<SyncState> {
    // Load buildInfo only for states that need it — avoids a JOIN+DISTINCT in the
    // shared syncInstanceState query that stop/destroy/archive paths never use.
    if (
      box.snapshot === null &&
      [BoxState.PENDING_BUILD, BoxState.BUILDING_SNAPSHOT, BoxState.UNKNOWN].includes(box.state)
    ) {
      await this.loadBuildInfo(box)
    }

    switch (box.state) {
      case BoxState.PULLING_SNAPSHOT: {
        if (!box.runnerId) {
          // Using the PULLING_SNAPSHOT state for the case where the runner isn't assigned yet as well
          return this.handleUnassignedRunnerBox(box, lockCode)
        } else {
          return this.handleRunnerBoxStartedStateCheck(box, lockCode)
        }
      }
      case BoxState.PENDING_BUILD: {
        return this.handleUnassignedRunnerBox(box, lockCode, true)
      }
      case BoxState.BUILDING_SNAPSHOT: {
        return this.handleRunnerBoxBuildingSnapshotStateOnDesiredStateStart(box, lockCode)
      }
      case BoxState.UNKNOWN: {
        return this.handleRunnerBoxUnknownStateOnDesiredStateStart(box, lockCode)
      }
      case BoxState.ARCHIVED:
      case BoxState.ARCHIVING:
      case BoxState.STOPPED: {
        return this.handleRunnerBoxStoppedOrArchivedStateOnDesiredStateStart(box, lockCode)
      }
      case BoxState.RESTORING:
      case BoxState.CREATING:
      case BoxState.STARTING: {
        return this.handleRunnerBoxStartedStateCheck(box, lockCode)
      }
      case BoxState.ERROR: {
        this.logger.error(`Box ${box.id} is in error state on desired state start`)
        return DONT_SYNC_AGAIN
      }
    }

    return DONT_SYNC_AGAIN
  }

  /**
   * Loads the buildInfo relation for a box.
   * Uses QueryBuilder with getMany() to avoid the SELECT DISTINCT subquery
   * that TypeORM generates when combining relations with findOne/LIMIT.
   * Since box.id is a PK and BuildInfo is @ManyToOne, at most one row is returned.
   */
  private async loadBuildInfo(box: Box): Promise<void> {
    const [result] = await this.boxRepository
      .createQueryBuilder('box')
      .leftJoinAndSelect('box.buildInfo', 'buildInfo')
      .where('box.id = :id', { id: box.id })
      .cache(`box:buildInfo:${box.id}`, BOX_BUILD_INFO_CACHE_TTL_MS)
      .getMany()
    box.buildInfo = result?.buildInfo ?? null
  }

  private async handleRunnerBoxBuildingSnapshotStateOnDesiredStateStart(
    box: Box,
    lockCode: LockCode,
  ): Promise<SyncState> {
    // Check for timeout - allow up to 60 minutes since the last box update
    const timeoutMinutes = 60
    const timeoutMs = timeoutMinutes * 60 * 1000

    if (box.updatedAt && Date.now() - box.updatedAt.getTime() > timeoutMs) {
      await this.updateBoxState(
        box,
        BoxState.BUILD_FAILED,
        lockCode,
        undefined,
        'Timeout while building snapshot on runner',
      )
      return DONT_SYNC_AGAIN
    }

    const snapshotRunner = await this.runnerService.getSnapshotRunner(box.runnerId, box.buildInfo.snapshotRef)
    if (snapshotRunner) {
      switch (snapshotRunner.state) {
        case SnapshotRunnerState.READY: {
          // TODO: "UNKNOWN" should probably be changed to something else
          await this.updateBoxState(box, BoxState.UNKNOWN, lockCode)
          return SYNC_AGAIN
        }
        case SnapshotRunnerState.ERROR: {
          await this.updateBoxState(box, BoxState.BUILD_FAILED, lockCode, undefined, snapshotRunner.errorReason)
          return DONT_SYNC_AGAIN
        }
      }
    }
    if (!snapshotRunner || snapshotRunner.state === SnapshotRunnerState.BUILDING_SNAPSHOT) {
      // Sleep for a second and go back to syncing instance state
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return SYNC_AGAIN
    }

    return DONT_SYNC_AGAIN
  }

  private async handleUnassignedRunnerBox(box: Box, lockCode: LockCode, isBuild = false): Promise<SyncState> {
    // Get snapshot reference based on whether it's a pull or build operation
    let snapshotRef: string

    if (isBuild) {
      snapshotRef = box.buildInfo.snapshotRef
    } else {
      const snapshot = await this.snapshotService.getSnapshotByName(box.snapshot, box.organizationId)
      snapshotRef = snapshot.ref
    }

    const declarativeBuildScoreThreshold = this.configService.get('runnerScore.thresholds.declarativeBuild')

    // Try to assign an available runner with the snapshot already available
    try {
      const runner = await this.runnerService.getRandomAvailableRunner({
        regions: [box.region],
        boxClass: box.class,
        snapshotRef: snapshotRef,
        ...(isBuild &&
          declarativeBuildScoreThreshold !== undefined && {
            availabilityScoreThreshold: declarativeBuildScoreThreshold,
          }),
      })
      if (runner) {
        await this.updateBoxState(box, BoxState.UNKNOWN, lockCode, runner.id)
        return SYNC_AGAIN
      }
    } catch {
      // Continue to next assignment method
    }

    // Try to assign an available runner that is currently processing the snapshot
    const snapshotRunners = await this.runnerService.getSnapshotRunners(snapshotRef)
    const targetState = isBuild ? SnapshotRunnerState.BUILDING_SNAPSHOT : SnapshotRunnerState.PULLING_SNAPSHOT
    const targetBoxState = isBuild ? BoxState.BUILDING_SNAPSHOT : BoxState.PULLING_SNAPSHOT
    const errorBoxState = isBuild ? BoxState.BUILD_FAILED : BoxState.ERROR

    for (const snapshotRunner of snapshotRunners) {
      // Consider removing the runner usage rate check or improving it
      const runner = await this.runnerService.findOneOrFail(snapshotRunner.runnerId)

      if (snapshotRunner.state === SnapshotRunnerState.ERROR) {
        await this.updateBoxState(box, errorBoxState, lockCode, runner.id, snapshotRunner.errorReason)
        return DONT_SYNC_AGAIN
      }

      if (runner.unschedulable || runner.draining || runner.state !== RunnerState.READY) {
        continue
      }

      if (declarativeBuildScoreThreshold === undefined || runner.availabilityScore >= declarativeBuildScoreThreshold) {
        if (snapshotRunner.state === targetState) {
          await this.updateBoxState(box, targetBoxState, lockCode, runner.id)
          return SYNC_AGAIN
        }
      }
    }

    // Get excluded runner IDs based on operation type
    const excludedRunnerIds = await (isBuild
      ? this.runnerService.getRunnersWithMultipleSnapshotsBuilding()
      : this.runnerService.getRunnersWithMultipleSnapshotsPulling())

    // Try to assign an available runner to start processing the snapshot
    let runner: Runner

    try {
      runner = await this.runnerService.getRandomAvailableRunner({
        regions: [box.region],
        boxClass: box.class,
        excludedRunnerIds: excludedRunnerIds,
        ...(isBuild &&
          declarativeBuildScoreThreshold !== undefined && {
            availabilityScoreThreshold: declarativeBuildScoreThreshold,
          }),
      })
    } catch {
      // TODO: reconsider the timeout here
      // No runners available, wait for 3 seconds and retry
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return SYNC_AGAIN
    }

    if (isBuild) {
      this.buildOnRunner(box.buildInfo, runner, box.organizationId)
      await this.updateBoxState(box, BoxState.BUILDING_SNAPSHOT, lockCode, runner.id)
    } else {
      const snapshot = await this.snapshotService.getSnapshotByName(box.snapshot, box.organizationId)
      await this.runnerService.createSnapshotRunnerEntry(runner.id, snapshot.ref, SnapshotRunnerState.PULLING_SNAPSHOT)
      this.pullSnapshotToRunner(snapshot, runner)
      await this.updateBoxState(box, BoxState.PULLING_SNAPSHOT, lockCode, runner.id)
    }

    return SYNC_AGAIN
  }

  async pullSnapshotToRunner(snapshot: Snapshot, runner: Runner) {
    const internalRegistry = await this.dockerRegistryService.findInternalRegistryBySnapshotRef(
      snapshot.ref,
      runner.region,
    )
    if (!internalRegistry) {
      throw new Error('No internal registry found for box snapshot')
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    // Fire the pull request (runner returns 202 immediately)
    await runnerAdapter.pullSnapshot(snapshot.ref, internalRegistry)

    const pollTimeoutMs = 60 * 60 * 1_000 // 1 hour
    const pollIntervalMs = 5 * 1_000 // 5 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < pollTimeoutMs) {
      try {
        await runnerAdapter.getSnapshotInfo(snapshot.ref)
        return
      } catch (err) {
        if (err instanceof SnapshotStateError) {
          throw err
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  // Initiates the snapshot build on the runner and creates an SnapshotRunner depending on the result
  async buildOnRunner(buildInfo: BuildInfo, runner: Runner, organizationId: string) {
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    const sourceRegistries = await this.dockerRegistryService.getSourceRegistriesForDockerfile(
      buildInfo.dockerfileContent,
      organizationId,
    )

    // Fire build request (runner returns 202 immediately)
    await runnerAdapter.buildSnapshot(
      buildInfo,
      organizationId,
      sourceRegistries.length > 0 ? sourceRegistries : undefined,
    )

    const pollTimeoutMs = 60 * 60 * 1_000 // 1 hour
    const pollIntervalMs = 5 * 1_000 // 5 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < pollTimeoutMs) {
      try {
        await runnerAdapter.getSnapshotInfo(buildInfo.snapshotRef)
        break
      } catch (err) {
        if (err instanceof SnapshotStateError) {
          await this.runnerService.createSnapshotRunnerEntry(
            runner.id,
            buildInfo.snapshotRef,
            SnapshotRunnerState.ERROR,
            err.message,
          )
          return
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      }
    }

    if (Date.now() - startTime >= pollTimeoutMs) {
      await this.runnerService.createSnapshotRunnerEntry(
        runner.id,
        buildInfo.snapshotRef,
        SnapshotRunnerState.ERROR,
        'Timeout while building',
      )
      return
    }

    const exists = await runnerAdapter.snapshotExists(buildInfo.snapshotRef)
    let state = SnapshotRunnerState.BUILDING_SNAPSHOT
    if (exists) {
      state = SnapshotRunnerState.READY
    }

    await this.runnerService.createSnapshotRunnerEntry(runner.id, buildInfo.snapshotRef, state)
  }

  private async handleRunnerBoxUnknownStateOnDesiredStateStart(box: Box, lockCode: LockCode): Promise<SyncState> {
    const runner = await this.runnerService.findOneOrFail(box.runnerId)
    if (runner.state !== RunnerState.READY) {
      return DONT_SYNC_AGAIN
    }

    const organization = await this.organizationService.findOne(box.organizationId)

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    let internalRegistry: DockerRegistry
    let entrypoint: string[]
    let snapshotRef: string
    if (!box.buildInfo) {
      //  get internal snapshot name
      const snapshot = await this.snapshotService.getSnapshotByName(box.snapshot, box.organizationId)
      snapshotRef = snapshot.ref

      internalRegistry = await this.dockerRegistryService.findInternalRegistryBySnapshotRef(snapshotRef, runner.region)
      if (!internalRegistry) {
        throw new Error('No registry found for snapshot')
      }

      entrypoint = snapshot.entrypoint
    } else {
      snapshotRef = box.buildInfo.snapshotRef
      entrypoint = this.snapshotService.getEntrypointFromDockerfile(box.buildInfo.dockerfileContent)
    }

    const metadata = {
      ...organization?.boxMetadata,
      boxName: box.name,
    }

    const result = await runnerAdapter.createBox(
      box,
      snapshotRef,
      internalRegistry,
      entrypoint,
      metadata,
      this.configService.get('boxOtel.endpointUrl'),
    )

    await this.updateBoxState(box, BoxState.CREATING, lockCode, undefined, undefined, result?.daemonVersion)
    //  sync states again immediately for box
    return SYNC_AGAIN
  }

  private async handleRunnerBoxStoppedOrArchivedStateOnDesiredStateStart(
    box: Box,
    lockCode: LockCode,
  ): Promise<SyncState> {
    const organization = await this.organizationService.findOne(box.organizationId)

    //  check if box is assigned to a runner and if that runner is unschedulable
    //  if it is, move box to prevRunnerId, and set runnerId to null
    //  this will assign a new runner to the box and restore the box from the latest backup
    if (box.runnerId) {
      const runner = await this.runnerService.findOneOrFail(box.runnerId)
      const originalRunnerId = box.runnerId // Store original value

      const startScoreThreshold = this.configService.get('runnerScore.thresholds.start') || 0

      const shouldMoveToNewRunner =
        (runner.unschedulable || runner.state != RunnerState.READY || runner.availabilityScore < startScoreThreshold) &&
        box.backupState === BackupState.COMPLETED

      // if the runner is unschedulable/not ready and box has a valid backup, move box to a new runner
      if (shouldMoveToNewRunner) {
        box.prevRunnerId = originalRunnerId
        box.runnerId = null

        await this.boxRepository.update(
          box.id,
          {
            updateData: {
              prevRunnerId: originalRunnerId,
              runnerId: null,
            },
          },
          true,
        )
      }

      // If the box is on a runner and its backupState is COMPLETED
      // but there are too many running boxes on that runner, move it to a less used runner
      if (box.backupState === BackupState.COMPLETED) {
        if (runner.availabilityScore < this.configService.getOrThrow('runnerScore.thresholds.availability')) {
          const availableRunners = await this.runnerService.findAvailableRunners({
            regions: [box.region],
            boxClass: box.class,
          })
          const lessUsedRunners = availableRunners.filter((runner) => runner.id !== originalRunnerId)

          //  temp workaround to move boxes to less used runner
          if (lessUsedRunners.length > 0) {
            box.prevRunnerId = originalRunnerId
            box.runnerId = null

            await this.boxRepository.update(
              box.id,
              {
                updateData: {
                  prevRunnerId: originalRunnerId,
                  runnerId: null,
                },
              },
              true,
            )
            try {
              const runnerAdapter = await this.runnerAdapterFactory.create(runner)
              await runnerAdapter.destroyBox(box.id)
            } catch (e) {
              if (e.response?.status !== 404 && e.statusCode !== 404) {
                this.logger.error(`Failed to cleanup box ${box.id} on previous runner ${runner.id}:`, e)
              }
            }
          }
        }
      }
    }

    if (box.runnerId === null) {
      //  if box has no runner, check if backup is completed
      //  if not, set box to error
      //  if backup is completed, get random available runner and start box
      //  use the backup to start the box

      if (box.backupState !== BackupState.COMPLETED) {
        await this.updateBoxState(
          box,
          BoxState.ERROR,
          lockCode,
          undefined,
          'Box has no runner and backup is not completed',
        )
        return DONT_SYNC_AGAIN
      }

      const syncCheck = await this.restoreBoxOnNewRunner(box, lockCode, organization, box.prevRunnerId)
      if (syncCheck !== null) {
        return syncCheck
      }
    } else {
      // if box has runner, start box
      const runner = await this.runnerService.findOneOrFail(box.runnerId)

      if (runner.state !== RunnerState.READY) {
        return DONT_SYNC_AGAIN
      }

      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      const metadata: { [key: string]: string } = { ...organization?.boxMetadata }
      if (box.volumes?.length) {
        metadata['volumes'] = JSON.stringify(
          box.volumes.map((v) => ({ volumeId: v.volumeId, mountPath: v.mountPath, subpath: v.subpath })),
        )
      }

      try {
        await runnerAdapter.startBox(box.id, box.authToken, metadata)
      } catch (error) {
        // Check against a list of substrings that should trigger an automatic recovery
        if (error?.message) {
          const matchesRecovery = RECOVERY_ERROR_SUBSTRINGS.some((substring) =>
            error.message.toLowerCase().includes(substring.toLowerCase()),
          )
          if (matchesRecovery) {
            try {
              await this.restoreBoxOnNewRunner(box, lockCode, organization, box.runnerId, true)
              this.logger.warn(`Box ${box.id} transferred to a new runner`)
              return SYNC_AGAIN
            } catch (restoreError) {
              this.logger.warn(`Box ${box.id} recovery attempt failed:`, restoreError.message)
            }
          }
        }
        throw error
      }

      await this.updateBoxState(box, BoxState.STARTING, lockCode)
      return SYNC_AGAIN
    }

    return SYNC_AGAIN
  }

  //  used to check if box is started on runner and update box state accordingly
  //  also used to handle the case where a box is started on a runner and then transferred to a new runner
  private async handleRunnerBoxStartedStateCheck(box: Box, lockCode: LockCode): Promise<SyncState> {
    //  edge case when box is being transferred to a new runner
    if (!box.runnerId) {
      return SYNC_AGAIN
    }

    const runner = await this.runnerService.findOneOrFail(box.runnerId)

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    const boxInfo = await runnerAdapter.boxInfo(box.id)

    switch (boxInfo.state) {
      case BoxState.STARTED: {
        //  if previous backup state is error or completed, set backup state to none
        if ([BackupState.ERROR, BackupState.COMPLETED].includes(box.backupState)) {
          await this.updateBoxState(
            box,
            BoxState.STARTED,
            lockCode,
            undefined,
            undefined,
            boxInfo.daemonVersion,
            BackupState.NONE,
          )
          return DONT_SYNC_AGAIN
        } else {
          await this.updateBoxState(box, BoxState.STARTED, lockCode, undefined, undefined, boxInfo.daemonVersion)

          //  if box was transferred to a new runner, remove it from the old runner
          if (box.prevRunnerId) {
            await this.removeBoxFromPreviousRunner(box)
          }

          return DONT_SYNC_AGAIN
        }
      }
      case BoxState.STARTING:
        if (await this.checkTimeoutError(box, 5, 'Timeout while starting box')) {
          return DONT_SYNC_AGAIN
        }
        break
      case BoxState.RESTORING:
        if (await this.checkTimeoutError(box, 30, 'Timeout while starting box')) {
          return DONT_SYNC_AGAIN
        }
        break
      case BoxState.CREATING: {
        if (await this.checkTimeoutError(box, 15, 'Timeout while creating box')) {
          return DONT_SYNC_AGAIN
        }
        break
      }
      case BoxState.UNKNOWN: {
        await this.updateBoxState(box, BoxState.UNKNOWN, lockCode)
        break
      }
      case BoxState.ERROR: {
        await this.updateBoxState(
          box,
          BoxState.ERROR,
          lockCode,
          undefined,
          'Box entered error state on runner during startup wait loop',
        )
        break
      }
      case BoxState.PULLING_SNAPSHOT: {
        if (await this.checkTimeoutError(box, 30, 'Timeout while pulling snapshot')) {
          return DONT_SYNC_AGAIN
        }
        await this.updateBoxState(box, BoxState.PULLING_SNAPSHOT, lockCode)
        break
      }
      case BoxState.DESTROYED: {
        this.logger.warn(
          `Box ${box.id} is in destroyed state while starting on runner ${box.runnerId}, prev runner ${box.prevRunnerId}`,
        )
        await this.checkTimeoutError(box, 15, 'Timeout while starting box: Box is in unknown state on runner')
        return DONT_SYNC_AGAIN
      }
      // also any other state that is not STARTED
      default: {
        this.logger.error(`Box ${box.id} is in unexpected state ${boxInfo.state}`)
        await this.updateBoxState(
          box,
          BoxState.ERROR,
          lockCode,
          undefined,
          `Box is in unexpected state: ${boxInfo.state}`,
        )
        break
      }
    }

    return SYNC_AGAIN
  }

  private async checkTimeoutError(box: Box, timeoutMinutes: number, errorReason: string): Promise<boolean> {
    const lastActivityAt = await this.boxActivityService.getLastActivityAt(box.id)
    if (lastActivityAt && lastActivityAt.getTime() < Date.now() - 1000 * 60 * timeoutMinutes) {
      const updateData: Partial<Box> = {
        state: BoxState.ERROR,
        errorReason,
        recoverable: false,
      }
      await this.boxRepository.update(box.id, { updateData, entity: box })
      return true
    }
    return false
  }

  private async restoreBoxOnNewRunner(
    box: Box,
    lockCode: LockCode,
    organization: Organization,
    excludedRunnerId: string,
    isRecovery?: boolean,
  ): Promise<SyncState | null> {
    let lockKey: string | null = null

    // Recovery lock to prevent frequent automatic restore attempts
    if (isRecovery) {
      lockKey = `box-${box.id}-restored-cooldown`
      const sixHoursInSeconds = 6 * 60 * 60
      const acquired = await this.redisLockProvider.lock(lockKey, sixHoursInSeconds)
      if (!acquired) {
        return null
      }
    }

    if (!box.backupRegistryId) {
      throw new Error('No registry found for backup')
    }

    const registry = await this.dockerRegistryService.findOne(box.backupRegistryId)
    if (!registry) {
      throw new Error('No registry found for backup')
    }

    //  make sure we pick a runner that has the base snapshot
    let baseSnapshot: Snapshot | null = null
    if (box.snapshot) {
      try {
        baseSnapshot = await this.snapshotService.getSnapshotByName(box.snapshot, box.organizationId)
      } catch (e) {
        if (e instanceof NotFoundException) {
          //  if the base snapshot is not found, we'll use any available runner later
        } else {
          if (isRecovery) {
            return SYNC_AGAIN
          }
          //  for all other errors, throw them
          throw e
        }
      }
    }

    const snapshotRef = baseSnapshot ? baseSnapshot.ref : null

    let availableRunners: Runner[] = []

    const excludedRunnerIds: string[] = excludedRunnerId ? [excludedRunnerId] : []

    const runnersWithBaseSnapshot: Runner[] = snapshotRef
      ? await this.runnerService.findAvailableRunners({
          regions: [box.region],
          boxClass: box.class,
          snapshotRef,
          excludedRunnerIds,
        })
      : []
    if (runnersWithBaseSnapshot.length > 0) {
      availableRunners = runnersWithBaseSnapshot
    } else {
      //  if no runner has the base snapshot, get all available runners
      availableRunners = await this.runnerService.findAvailableRunners({
        regions: [box.region],
        excludedRunnerIds,
      })
    }

    //  check if we have any available runners after filtering
    if (availableRunners.length === 0) {
      // Sync state again later. Runners are unavailable
      if (isRecovery) {
        await this.redisLockProvider.unlock(lockKey)
      }
      return DONT_SYNC_AGAIN
    }

    //  get random runner from available runners
    const randomRunnerIndex = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1) + min)
    const runner = availableRunners[randomRunnerIndex(0, availableRunners.length - 1)]

    //  verify the runner is still available and ready
    if (!runner || runner.state !== RunnerState.READY || runner.unschedulable) {
      this.logger.warn(`Selected runner ${runner?.id || 'null'} is no longer available, retrying box assignment`)
      if (isRecovery) {
        await this.redisLockProvider.unlock(lockKey)
      }
      return SYNC_AGAIN
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    const existingBackups = box.existingBackupSnapshots
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((existingSnapshot) => existingSnapshot.snapshotName)

    let validBackup: string | null = null
    let exists = false

    for (const existingBackup of existingBackups) {
      try {
        if (!validBackup && box.backupSnapshot) {
          //  last snapshot is the current snapshot, so we don't need to check it
          //  just in case, we'll use the value from the backupSnapshot property
          validBackup = box.backupSnapshot
        } else {
          validBackup = existingBackup
        }

        if (!validBackup) {
          continue
        }

        await runnerAdapter.inspectSnapshotInRegistry(validBackup, registry)
        exists = true
        break
      } catch (error) {
        this.logger.error(`Failed to check if backup snapshot ${validBackup} exists in registry ${registry.id}:`, error)
      }
    }

    const restoreBackupSnapshotRetryKey = `restore-backup-snapshot-retry-${box.id}`
    if (!exists) {
      if (!isRecovery) {
        // Check retry count - allow up to 3 attempts for transient issues
        const retryCountRaw = await this.redis.get(restoreBackupSnapshotRetryKey)
        const retryCount = retryCountRaw ? parseInt(retryCountRaw) : 0

        if (retryCount < 3) {
          // Increment retry count with 10 minute TTL, let syncStates cron pick up the retry later
          await this.redis.setex(restoreBackupSnapshotRetryKey, 600, String(retryCount + 1))
          this.logger.warn(`No valid backup snapshot found for box ${box.id}, retry attempt ${retryCount + 1}/3`)
          return DONT_SYNC_AGAIN
        }

        // After 3 retries, error out and clear the retry counter
        await this.redis.del(restoreBackupSnapshotRetryKey)
        await this.updateBoxState(box, BoxState.ERROR, lockCode, undefined, 'No valid backup snapshot found')
      } else {
        throw new Error('No valid backup snapshot found')
      }
      return SYNC_AGAIN
    }

    // Clear the retry counter on success
    await this.redis.del(restoreBackupSnapshotRetryKey)

    await this.updateBoxState(box, BoxState.RESTORING, lockCode, runner.id)

    const metadata = {
      ...organization?.boxMetadata,
      boxName: box.name,
    }

    await runnerAdapter.createBox(
      box,
      validBackup,
      registry,
      undefined,
      metadata,
      this.configService.get('boxOtel.endpointUrl'),
    )
    return null
  }

  private async removeBoxFromPreviousRunner(box: Box): Promise<void> {
    const runner = await this.runnerService.findOne(box.prevRunnerId)
    if (!runner) {
      this.logger.warn(`Previously assigned runner ${box.prevRunnerId} for box ${box.id} not found`)

      await this.boxRepository.update(box.id, { updateData: { prevRunnerId: null } }, true)
      return
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    try {
      // First try to destroy the box
      await runnerAdapter.destroyBox(box.id)
    } catch (error) {
      if (error.response?.status !== 404 && error.statusCode !== 404) {
        this.logger.error(`Failed to cleanup box ${box.id} on previous runner ${runner.id}:`, error)
        throw error
      }
    }

    await this.boxRepository.update(box.id, { updateData: { prevRunnerId: null } }, true)
  }
}

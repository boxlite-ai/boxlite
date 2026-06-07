/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, NotFoundException, OnApplicationShutdown } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Cron, CronExpression } from '@nestjs/schedule'
import { In, IsNull, Not, Repository } from 'typeorm'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { SavedImage } from '../entities/saved-image.entity'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { RunnerArtifactCache } from '../entities/runner-artifact-cache.entity'
import { Runner } from '../entities/runner.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'
import { v4 as uuidv4 } from 'uuid'
import { RunnerNotReadyError } from '../errors/runner-not-ready.error'
import { RedisLockProvider } from '../common/redis-lock.provider'
import { OrganizationService } from '../../organization/services/organization.service'
import { BuildInfo } from '../entities/build-info.entity'
import { fromAxiosError } from '../../common/utils/from-axios-error'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { RunnerService } from '../services/runner.service'
import { TrackableJobExecutions } from '../../common/interfaces/trackable-job-executions'
import { TrackJobExecution } from '../../common/decorators/track-job-execution.decorator'
import { setTimeout as sleep } from 'timers/promises'
import { LogExecution } from '../../common/decorators/log-execution.decorator'
import { WithInstrumentation } from '../../common/decorators/otel.decorator'
import { RunnerAdapterFactory, RunnerArtifactInfo, ArtifactDigestResponse } from '../runner-adapter/runnerAdapter'
import { RuntimeArtifactStateError } from '../errors/runtime-artifact-state-error'
import { SavedImageEvents } from '../constants/saved-image-events'
import { SavedImageCreatedEvent } from '../events/saved-image-created.event'
import { SavedImageService } from '../services/saved-image.service'
import { OnAsyncEvent } from '../../common/decorators/on-async-event.decorator'
import { parseDockerImage } from '../../common/utils/docker-image.util'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { BackupState } from '../enums/backup-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { SavedImageActivatedEvent } from '../events/saved-image-activated.event'
import { TypedConfigService } from '../../config/typed-config.service'
import { createBoxLiteInternalArtifactRef } from '../utils/artifact-ref.util'

const SYNC_AGAIN = 'sync-again'
const DONT_SYNC_AGAIN = 'dont-sync-again'
const DEFAULT_SAVED_IMAGE_DEACTIVATION_TIMEOUT_MINUTES = 14 * 24 * 60 // 14 days
type SyncState = typeof SYNC_AGAIN | typeof DONT_SYNC_AGAIN

@Injectable()
export class RuntimeArtifactManager implements TrackableJobExecutions, OnApplicationShutdown {
  activeJobs = new Set<string>()

  private readonly logger = new Logger(RuntimeArtifactManager.name)
  //  generate a unique instance id used to ensure only one instance of the worker is handing the
  //  saved image artifact activation
  private readonly instanceId = uuidv4()

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(SavedImage)
    private readonly savedImageRepository: Repository<SavedImage>,
    @InjectRepository(RunnerArtifactCache)
    private readonly runnerArtifactCacheRepository: Repository<RunnerArtifactCache>,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
    private readonly sandboxRepository: SandboxRepository,
    @InjectRepository(BuildInfo)
    private readonly buildInfoRepository: Repository<BuildInfo>,
    private readonly runnerService: RunnerService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly organizationService: OrganizationService,
    private readonly savedImageService: SavedImageService,
    private readonly configService: TypedConfigService,
  ) {}

  async onApplicationShutdown() {
    //  wait for all active jobs to finish
    while (this.activeJobs.size > 0) {
      this.logger.log(`Waiting for ${this.activeJobs.size} active jobs to finish`)
      await sleep(1000)
    }
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { name: 'sync-runner-artifact-caches', waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution('sync-runner-artifact-caches')
  @WithInstrumentation()
  async syncRunnerArtifactCaches() {
    const lockKey = 'sync-runner-artifact-caches-lock'
    const lockTtl = 10 * 60 // seconds (10 min)
    if (!(await this.redisLockProvider.lock(lockKey, lockTtl))) {
      return
    }

    const skip = (await this.redis.get('sync-runner-artifact-caches-skip')) || 0

    const savedImages = await this.savedImageRepository
      .createQueryBuilder('savedImage')
      .innerJoin('organization', 'org', 'org.id = savedImage.organizationId')
      .where('savedImage.state = :savedImageState', { savedImageState: SavedImageState.ACTIVE })
      .andWhere('org.suspended = false')
      .orderBy('savedImage.createdAt', 'ASC')
      .take(100)
      .skip(Number(skip))
      .getMany()

    if (savedImages.length === 0) {
      await this.redisLockProvider.unlock(lockKey)
      await this.redis.set('sync-runner-artifact-caches-skip', 0)
      return
    }

    await this.redis.set('sync-runner-artifact-caches-skip', Number(skip) + savedImages.length)

    const results = await Promise.allSettled(
      savedImages.map(async (savedImage) => {
        const regions = await this.savedImageService.getSavedImageRegions(savedImage.id)

        const sharedRegionIds = regions.filter((r) => r.organizationId === null).map((r) => r.id)
        const organizationRegionIds = regions
          .filter((r) => r.organizationId === savedImage.organizationId)
          .map((r) => r.id)

        return this.propagateSavedImageArtifactToRunners(savedImage, sharedRegionIds, organizationRegionIds)
      }),
    )

    // Log all promise errors
    results.forEach((result) => {
      if (result.status === 'rejected') {
        this.logger.error(`Error propagating saved image artifact to runners: ${fromAxiosError(result.reason)}`)
      }
    })

    await this.redisLockProvider.unlock(lockKey)
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'sync-runner-artifact-cache-states', waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution('sync-runner-artifact-cache-states')
  @WithInstrumentation()
  async syncRunnerArtifactCacheStates() {
    //  this approach is not ideal, as if the number of runners is large, this will take a long time
    //  also, if some artifacts stuck in a "pulling" state, they will infest the queue
    //  todo: find a better approach

    const lockKey = 'sync-runner-artifact-cache-states-lock'
    if (!(await this.redisLockProvider.lock(lockKey, 30))) {
      return
    }

    const runnerArtifactCaches = await this.runnerArtifactCacheRepository
      .createQueryBuilder('runnerArtifactCache')
      .where({
        state: In([
          RunnerArtifactCacheState.PULLING_ARTIFACT,
          RunnerArtifactCacheState.BUILDING_ARTIFACT,
          RunnerArtifactCacheState.REMOVING,
        ]),
      })
      .orderBy('RANDOM()')
      .take(100)
      .getMany()

    await Promise.allSettled(
      runnerArtifactCaches.map((runnerArtifactCache) => {
        return this.syncRunnerArtifactCacheState(runnerArtifactCache).catch((err) => {
          if (err.code !== 'ECONNRESET') {
            if (err instanceof RunnerNotReadyError) {
              this.logger.debug(
                `Runner ${runnerArtifactCache.runnerId} is not ready while trying to sync runner artifact cache ${runnerArtifactCache.id}: ${err}`,
              )
              return
            }
            this.logger.error(
              `Error syncing runner artifact cache state ${runnerArtifactCache.id}: ${fromAxiosError(err)}`,
            )
            this.runnerArtifactCacheRepository.update(runnerArtifactCache.id, {
              state: RunnerArtifactCacheState.ERROR,
              errorReason: fromAxiosError(err).message,
            })
          }
        })
      }),
    )

    await this.redisLockProvider.unlock(lockKey)
  }

  async syncRunnerArtifactCacheState(runnerArtifactCache: RunnerArtifactCache): Promise<void> {
    const runner = await this.runnerService.findOne(runnerArtifactCache.runnerId)
    if (!runner) {
      //  cleanup the runner artifact cache record if the runner is not found
      //  this can happen if the runner is deleted from the database without cleaning up the runner artifact caches
      await this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id)
      this.logger.warn(
        `Runner ${runnerArtifactCache.runnerId} not found while trying to process runner artifact cache ${runnerArtifactCache.id}. Runner artifact cache has been removed.`,
      )
      return
    }

    if (runner.state !== RunnerState.READY) {
      //  todo: handle timeout policy
      //  for now just remove the runner artifact cache record if the runner is not ready
      await this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id)

      throw new RunnerNotReadyError(`Runner ${runner.id} is not ready`)
    }

    switch (runnerArtifactCache.state) {
      case RunnerArtifactCacheState.PULLING_ARTIFACT:
        await this.handleRunnerArtifactCacheStatePullingArtifact(runnerArtifactCache, runner)
        break
      case RunnerArtifactCacheState.BUILDING_ARTIFACT:
        await this.handleRunnerArtifactCacheStateBuildingArtifact(runnerArtifactCache, runner)
        break
      case RunnerArtifactCacheState.REMOVING:
        await this.handleRunnerArtifactCacheStateRemoving(runnerArtifactCache, runner)
        break
    }
  }

  async propagateSavedImageArtifactToRunners(
    savedImage: SavedImage,
    sharedRegionIds: string[],
    organizationRegionIds: string[],
  ) {
    //  todo: remove try catch block and implement error handling
    try {
      //  get all runners in the regions to propagate to
      const runners = await this.runnerRepository.find({
        where: {
          state: RunnerState.READY,
          unschedulable: Not(true),
          region: In([...sharedRegionIds, ...organizationRegionIds]),
        },
      })

      const sharedRunners = runners.filter((runner) => sharedRegionIds.includes(runner.region))
      const sharedRunnerIds = sharedRunners.map((runner) => runner.id)

      const organizationRunners = runners.filter((runner) => organizationRegionIds.includes(runner.region))
      const organizationRunnerIds = organizationRunners.map((runner) => runner.id)

      //  get all runners where the saved image artifact is already propagated to (or in progress)
      const sharedRunnerArtifactCaches = await this.runnerArtifactCacheRepository.find({
        where: {
          artifactRef: savedImage.artifactRef,
          state: In([RunnerArtifactCacheState.READY, RunnerArtifactCacheState.PULLING_ARTIFACT]),
          runnerId: In(sharedRunnerIds),
        },
      })
      const sharedRunnerArtifactCachesDistinctRunnersIds = new Set(
        sharedRunnerArtifactCaches.map((runnerArtifactCache) => runnerArtifactCache.runnerId),
      )

      const organizationRunnerArtifactCaches = await this.runnerArtifactCacheRepository.find({
        where: {
          artifactRef: savedImage.artifactRef,
          state: In([RunnerArtifactCacheState.READY, RunnerArtifactCacheState.PULLING_ARTIFACT]),
          runnerId: In(organizationRunnerIds),
        },
      })
      const organizationRunnerArtifactCachesDistinctRunnersIds = new Set(
        organizationRunnerArtifactCaches.map((runnerArtifactCache) => runnerArtifactCache.runnerId),
      )

      //  get all runners where the saved image artifact is not propagated to
      const unallocatedSharedRunners = sharedRunners.filter(
        (runner) => !sharedRunnerArtifactCachesDistinctRunnersIds.has(runner.id),
      )
      const unallocatedOrganizationRunners = organizationRunners.filter(
        (runner) => !organizationRunnerArtifactCachesDistinctRunnersIds.has(runner.id),
      )

      const runnersToPropagateTo: Runner[] = []

      // propagate the saved image artifact to all organization runners
      runnersToPropagateTo.push(...unallocatedOrganizationRunners)

      // respect the propagation limit for shared runners
      const sharedRunnersPropagateLimit = Math.max(
        0,
        Math.ceil(sharedRunners.length / 3) - sharedRunnerArtifactCachesDistinctRunnersIds.size,
      )
      runnersToPropagateTo.push(
        ...unallocatedSharedRunners.sort(() => Math.random() - 0.5).slice(0, sharedRunnersPropagateLimit),
      )

      if (runnersToPropagateTo.length === 0) {
        return
      }

      // regionId -> registry
      const internalRegistriesMap = new Map<string, DockerRegistry>()

      for (const regionId of [...sharedRegionIds, ...organizationRegionIds]) {
        const registry = await this.dockerRegistryService.findInternalRegistryByArtifactRef(
          savedImage.artifactRef,
          regionId,
        )
        if (registry) {
          internalRegistriesMap.set(regionId, registry)
        }
      }

      const results = await Promise.allSettled(
        runnersToPropagateTo.map(async (runner) => {
          const internalRegistry = internalRegistriesMap.get(runner.region)
          if (!internalRegistry) {
            throw new Error(
              `No internal registry found for artifact ${savedImage.artifactRef} in region ${runner.region}`,
            )
          }

          let runnerArtifactCache = await this.runnerService.getRunnerArtifactCache(runner.id, savedImage.artifactRef)

          try {
            if (!runnerArtifactCache) {
              await this.runnerService.createRunnerArtifactCacheEntry(
                runner.id,
                savedImage.artifactRef,
                RunnerArtifactCacheState.PULLING_ARTIFACT,
              )
              runnerArtifactCache = await this.runnerService.getRunnerArtifactCache(runner.id, savedImage.artifactRef)
              await this.pullRunnerArtifactCache(runner, savedImage.artifactRef, internalRegistry)
            } else if (runnerArtifactCache.state === RunnerArtifactCacheState.PULLING_ARTIFACT) {
              await this.handleRunnerArtifactCacheStatePullingArtifact(runnerArtifactCache, runner)
            }
          } catch (err) {
            this.logger.error(`Error propagating saved image artifact to runner ${runner.id}: ${fromAxiosError(err)}`)
            const errorReason = err instanceof Error ? err.message : String(err)
            if (!runnerArtifactCache) {
              runnerArtifactCache = await this.runnerService.getRunnerArtifactCache(runner.id, savedImage.artifactRef)
            }
            if (!runnerArtifactCache) {
              await this.runnerService.createRunnerArtifactCacheEntry(
                runner.id,
                savedImage.artifactRef,
                RunnerArtifactCacheState.ERROR,
                errorReason,
              )
              return
            }
            runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
            runnerArtifactCache.errorReason = errorReason
            await this.runnerArtifactCacheRepository.update(runnerArtifactCache.id, runnerArtifactCache)
          }
        }),
      )

      results.forEach((result) => {
        if (result.status === 'rejected') {
          this.logger.error(result.reason)
        }
      })
    } catch (err) {
      this.logger.error(err)
    }
  }

  async pullRunnerArtifactCache(
    runner: Runner,
    artifactRef: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
  ) {
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    // Runner returns immediately; polling for completion is handled by syncRunnerSavedImageStates cron
    await runnerAdapter.pullArtifact(artifactRef, registry, destinationRegistry, destinationRef)
  }

  async handleRunnerArtifactCacheStatePullingArtifact(runnerArtifactCache: RunnerArtifactCache, runner: Runner) {
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    try {
      await runnerAdapter.getArtifactInfo(runnerArtifactCache.artifactRef)
      runnerArtifactCache.state = RunnerArtifactCacheState.READY
      await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
      return
    } catch (err) {
      if (err instanceof RuntimeArtifactStateError) {
        runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
        runnerArtifactCache.errorReason = err.errorReason
        await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
        return
      }
    }

    const timeoutMinutes = 60
    const timeoutMs = timeoutMinutes * 60 * 1000
    if (Date.now() - runnerArtifactCache.updatedAt.getTime() > timeoutMs) {
      runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
      runnerArtifactCache.errorReason = 'Timeout while pulling artifact to runner'
      await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
      return
    }

    const retryTimeoutMinutes = 10
    const retryTimeoutMs = retryTimeoutMinutes * 60 * 1000
    if (Date.now() - runnerArtifactCache.createdAt.getTime() > retryTimeoutMs) {
      const internalRegistry = await this.dockerRegistryService.findInternalRegistryByArtifactRef(
        runnerArtifactCache.artifactRef,
        runner.region,
      )
      if (!internalRegistry) {
        throw new Error(
          `No internal registry found for artifact ${runnerArtifactCache.artifactRef} in region ${runner.region}`,
        )
      }
      await this.pullRunnerArtifactCache(runner, runnerArtifactCache.artifactRef, internalRegistry)
      return
    }
  }

  async handleRunnerArtifactCacheStateBuildingArtifact(runnerArtifactCache: RunnerArtifactCache, runner: Runner) {
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    try {
      await runnerAdapter.getArtifactInfo(runnerArtifactCache.artifactRef)
      runnerArtifactCache.state = RunnerArtifactCacheState.READY
      await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
      return
    } catch (err) {
      if (err instanceof RuntimeArtifactStateError) {
        runnerArtifactCache.state = RunnerArtifactCacheState.ERROR
        runnerArtifactCache.errorReason = err.errorReason
        await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
        return
      }
    }
  }

  // Pulls stopped sandboxes' backup snapshots to another runner to prepare for reassignment during draining
  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'migrate-draining-runner-backup-snapshots', waitForCompletion: true })
  @TrackJobExecution()
  @LogExecution('migrate-draining-runner-backup-snapshots')
  @WithInstrumentation()
  private async handleMigrateDrainingRunnerBackupSnapshots() {
    const lockKey = 'migrate-draining-runner-backup-snapshots'
    const hasLock = await this.redisLockProvider.lock(lockKey, 60)
    if (!hasLock) {
      return
    }

    try {
      const drainingRunners = await this.runnerRepository.find({
        where: {
          draining: true,
          state: RunnerState.READY,
        },
      })

      this.logger.debug(`Checking ${drainingRunners.length} draining runners for backup snapshot migration`)

      await Promise.allSettled(
        drainingRunners.map(async (runner) => {
          try {
            const sandboxes = await this.sandboxRepository.find({
              where: {
                runnerId: runner.id,
                state: SandboxState.STOPPED,
                desiredState: SandboxDesiredState.STOPPED,
                backupState: BackupState.COMPLETED,
                backupSnapshot: Not(IsNull()),
              },
              take: 100,
            })

            this.logger.debug(
              `Found ${sandboxes.length} eligible sandboxes on draining runner ${runner.id} for backup snapshot migration`,
            )

            await Promise.allSettled(
              sandboxes.map(async (sandbox) => {
                const sandboxLockKey = `draining-runner-backup-snapshot-migration:${sandbox.id}`
                const hasSandboxLock = await this.redisLockProvider.lock(sandboxLockKey, 3600)
                if (!hasSandboxLock) {
                  return
                }

                try {
                  // Get an available runner in the same region with the same class
                  const targetRunner = await this.runnerService.getRandomAvailableRunner({
                    regions: [sandbox.region],
                    sandboxClass: sandbox.class,
                    excludedRunnerIds: [runner.id],
                  })

                  // Check if runner artifact cache entry already exists
                  const existingEntry = await this.runnerService.getRunnerArtifactCache(
                    targetRunner.id,
                    sandbox.backupSnapshot,
                  )
                  if (existingEntry) {
                    if (existingEntry.state === RunnerArtifactCacheState.ERROR) {
                      // Clean up the failed entry so we can retry
                      this.logger.warn(
                        `Removing ERROR runner artifact cache entry ${existingEntry.id} for runner ${targetRunner.id} and backup snapshot ${sandbox.backupSnapshot} to allow retry`,
                      )
                      await this.runnerArtifactCacheRepository.delete(existingEntry.id)
                    } else {
                      this.logger.debug(
                        `Runner artifact cache entry already exists for runner ${targetRunner.id} and backup snapshot ${sandbox.backupSnapshot} (state: ${existingEntry.state})`,
                      )
                      // Do not unlock to avoid duplicates
                      return
                    }
                  }

                  // Find the backup registry to use as source for the pull
                  const registry = sandbox.backupRegistryId
                    ? await this.dockerRegistryService.findOne(sandbox.backupRegistryId)
                    : await this.dockerRegistryService.findInternalRegistryByArtifactRef(
                        sandbox.backupSnapshot,
                        targetRunner.region,
                      )

                  if (!registry) {
                    this.logger.warn(
                      `No registry found for backup snapshot ${sandbox.backupSnapshot} of sandbox ${sandbox.id}`,
                    )
                    await this.redisLockProvider.unlock(sandboxLockKey)
                    return
                  }

                  // Create runner artifact cache entry on the target runner
                  await this.runnerService.createRunnerArtifactCacheEntry(
                    targetRunner.id,
                    sandbox.backupSnapshot,
                    RunnerArtifactCacheState.PULLING_ARTIFACT,
                  )
                  await this.pullRunnerArtifactCache(targetRunner, sandbox.backupSnapshot, registry)

                  this.logger.log(
                    `Created runner artifact cache entry for sandbox ${sandbox.id} backup ${sandbox.backupSnapshot} on runner ${targetRunner.id} (migrating from draining runner ${runner.id})`,
                  )
                  await this.redisLockProvider.unlock(sandboxLockKey)
                } catch (e) {
                  if (e instanceof BadRequestError && e.message === 'No available runners') {
                    this.logger.warn(
                      `No available runners found in region ${sandbox.region} for sandbox ${sandbox.id} backup snapshot migration`,
                    )
                  } else {
                    this.logger.error(`Error migrating backup snapshot for sandbox ${sandbox.id}`, e)
                  }
                  await this.redisLockProvider.unlock(sandboxLockKey)
                }
              }),
            )
          } catch (e) {
            this.logger.error(`Error processing draining runner ${runner.id} for backup snapshot migration`, e)
          }
        }),
      )
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'check-saved-image-cleanup' })
  @TrackJobExecution()
  @LogExecution('check-saved-image-cleanup')
  @WithInstrumentation()
  async checkSavedImageCleanup() {
    const lockKey = 'check-saved-image-cleanup-lock'
    if (!(await this.redisLockProvider.lock(lockKey, 30))) {
      return
    }

    const savedImages = await this.savedImageRepository.find({
      where: {
        state: SavedImageState.REMOVING,
      },
    })

    await Promise.all(
      savedImages.map(async (savedImage) => {
        const countActiveSavedImages = await this.savedImageRepository.count({
          where: {
            state: SavedImageState.ACTIVE,
            artifactRef: savedImage.artifactRef,
          },
        })

        // Only remove runner artifact caches if no other savedImages depend on them
        if (countActiveSavedImages === 0) {
          await this.runnerArtifactCacheRepository.update(
            {
              artifactRef: savedImage.artifactRef,
            },
            {
              state: RunnerArtifactCacheState.REMOVING,
            },
          )
        }

        await this.savedImageRepository.remove(savedImage)
      }),
    )

    await this.redisLockProvider.unlock(lockKey)
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'check-saved-image-state' })
  @TrackJobExecution()
  @LogExecution('check-saved-image-state')
  @WithInstrumentation()
  async checkSavedImageState() {
    //  the first time the saved image is created it needs to be pushed to the internal registry
    //  before propagating to the runners
    //  this cron job will process the savedImage states until the saved image is active (or error)

    const savedImages = await this.savedImageRepository.find({
      where: {
        state: Not(
          In([
            SavedImageState.ACTIVE,
            SavedImageState.ERROR,
            SavedImageState.BUILD_FAILED,
            SavedImageState.INACTIVE,
          ]),
        ),
      },
    })

    await Promise.all(
      savedImages.map(async (savedImage) => {
        this.syncSavedImageState(savedImage.id)
      }),
    )
  }

  async syncSavedImageState(savedImageId: string): Promise<void> {
    const lockKey = `sync-saved-image-state-${savedImageId}`
    if (!(await this.redisLockProvider.lock(lockKey, 720))) {
      return
    }

    const savedImage = await this.savedImageRepository.findOne({
      where: { id: savedImageId },
    })

    if (
      !savedImage ||
      [
        SavedImageState.ACTIVE,
        SavedImageState.ERROR,
        SavedImageState.BUILD_FAILED,
        SavedImageState.INACTIVE,
      ].includes(savedImage.state)
    ) {
      await this.redisLockProvider.unlock(lockKey)
      return
    }

    let syncState = DONT_SYNC_AGAIN

    try {
      switch (savedImage.state) {
        case SavedImageState.PENDING:
          syncState = await this.handleSavedImageStatePending(savedImage)
          break
        case SavedImageState.PULLING:
        case SavedImageState.BUILDING:
          syncState = await this.handleCheckInitialRunnerSavedImageArtifact(savedImage)
          break
        case SavedImageState.REMOVING:
          syncState = await this.handleSavedImageStateRemoving(savedImage)
          break
      }
    } catch (error) {
      if (error.code === 'ECONNRESET') {
        syncState = SYNC_AGAIN
      } else {
        const message = error.message || String(error)
        await this.updateSavedImageState(savedImage.id, SavedImageState.ERROR, message)
      }
    }

    await this.redisLockProvider.unlock(lockKey)
    if (syncState === SYNC_AGAIN) {
      this.syncSavedImageState(savedImageId)
    }
  }

  async handleRunnerArtifactCacheStateRemoving(runnerArtifactCache: RunnerArtifactCache, runner: Runner) {
    if (!runner) {
      //  generally this should not happen
      //  in case the runner has been deleted from the database, delete the runner artifact cache record
      const errorMessage = `Runner not found while trying to remove artifact ${runnerArtifactCache.artifactRef} from runner ${runnerArtifactCache.runnerId}`
      this.logger.warn(errorMessage)

      this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id).catch((err) => {
        this.logger.error(fromAxiosError(err))
      })
      return
    }
    if (!runnerArtifactCache.artifactRef) {
      //  this should never happen
      //  remove the runner artifact cache record (it will be recreated again by the artifact propagation job)
      this.logger.warn(`Artifact ref not found for runner artifact cache ${runnerArtifactCache.id}`)
      this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id).catch((err) => {
        this.logger.error(fromAxiosError(err))
      })
      return
    }

    const runnerAdapter = await this.runnerAdapterFactory.create(runner)
    const exists = await runnerAdapter.artifactExists(runnerArtifactCache.artifactRef)
    if (!exists) {
      await this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id)
    } else {
      //  just in case the artifact is still there
      runnerAdapter.removeArtifact(runnerArtifactCache.artifactRef).catch((err) => {
        //  this should not happen, and is not critical
        //  if the runner can not remove the artifact, just delete the runner artifact cache record
        this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id).catch((err) => {
          this.logger.error(fromAxiosError(err))
        })
        //  and log the error for tracking
        const errorMessage = `Failed to do just in case remove artifact ${runnerArtifactCache.artifactRef} from runner ${runner.id}: ${fromAxiosError(err)}`
        this.logger.warn(errorMessage)
      })
    }
  }

  async handleSavedImageStateRemoving(savedImage: SavedImage): Promise<SyncState> {
    const runnerArtifactCacheItems = await this.runnerArtifactCacheRepository.find({
      where: {
        artifactRef: savedImage.artifactRef,
      },
    })

    if (runnerArtifactCacheItems.length === 0) {
      await this.savedImageRepository.remove(savedImage)
    }

    return DONT_SYNC_AGAIN
  }

  async handleCheckInitialRunnerSavedImageArtifact(savedImage: SavedImage): Promise<SyncState> {
    // Check for timeout - allow up to 30 minutes
    const timeoutMinutes = 30
    const timeoutMs = timeoutMinutes * 60 * 1000
    if (Date.now() - savedImage.updatedAt.getTime() > timeoutMs) {
      await this.updateSavedImageState(
        savedImage.id,
        SavedImageState.ERROR,
        'Timeout processing saved image artifact on initial runner',
      )
      return DONT_SYNC_AGAIN
    }

    // Check if the artifact ref is already set and it is already on the runner
    const runnerArtifactCache = await this.runnerArtifactCacheRepository.findOne({
      where: {
        artifactRef: savedImage.artifactRef,
        runnerId: savedImage.initialRunnerId,
      },
    })

    if (savedImage.artifactRef && runnerArtifactCache) {
      if (runnerArtifactCache.state === RunnerArtifactCacheState.READY && savedImage.size != null) {
        await this.updateSavedImageState(savedImage.id, SavedImageState.ACTIVE)
        return DONT_SYNC_AGAIN
      } else if (runnerArtifactCache.state === RunnerArtifactCacheState.ERROR) {
        await this.runnerArtifactCacheRepository.delete(runnerArtifactCache.id)
      }
    }

    const runner = await this.runnerService.findOneOrFail(savedImage.initialRunnerId)
    const runnerAdapter = await this.runnerAdapterFactory.create(runner)

    const initialImageRefOnRunner = savedImage.buildInfo ? savedImage.buildInfo.artifactRef : savedImage.artifactRef

    let artifactInfoResponse: RunnerArtifactInfo
    try {
      artifactInfoResponse = await runnerAdapter.getArtifactInfo(initialImageRefOnRunner)
    } catch (error) {
      if (error instanceof RuntimeArtifactStateError) {
        throw error
      } else {
        return DONT_SYNC_AGAIN
      }
    }

    const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(runner.region)
    if (!internalRegistry) {
      throw new Error('No internal registry found for saved image artifact')
    }

    const digestSyncState = await this.processSavedImageArtifactDigest(
      savedImage,
      internalRegistry,
      artifactInfoResponse.hash,
      artifactInfoResponse.sizeGB,
      artifactInfoResponse.entrypoint,
    )

    if (digestSyncState === DONT_SYNC_AGAIN) {
      return DONT_SYNC_AGAIN
    }

    let inspectedArtifactDigest: ArtifactDigestResponse | undefined
    try {
      inspectedArtifactDigest = await runnerAdapter.inspectArtifactInRegistry(savedImage.artifactRef, internalRegistry)
    } catch (error) {
      this.logger.error(`Failed to inspect artifact ${savedImage.artifactRef} in registry: ${error}`)
      return DONT_SYNC_AGAIN
    }

    if (savedImage.size == null && typeof inspectedArtifactDigest?.sizeGB === 'number') {
      await this.processSavedImageArtifactDigest(
        savedImage,
        internalRegistry,
        artifactInfoResponse.hash,
        inspectedArtifactDigest.sizeGB,
        artifactInfoResponse.entrypoint,
      )
    }

    try {
      await runnerAdapter.removeArtifact(initialImageRefOnRunner)
    } catch (error) {
      this.logger.error(`Failed to remove transient source artifact ${savedImage.imageName}: ${fromAxiosError(error)}`)
    }

    // For pull savedImages, best effort cleanup the original image now that we've computed the ref from it.
    // Only cleanup if there's no other savedImage in processing state using the same image.
    if (!savedImage.buildInfo) {
      try {
        const anotherSavedImage = await this.savedImageRepository.findOne({
          where: {
            imageName: savedImage.imageName,
            id: Not(savedImage.id),
            state: Not(In([SavedImageState.ACTIVE, SavedImageState.INACTIVE])),
          },
        })
        if (!anotherSavedImage) {
          await runnerAdapter.removeArtifact(savedImage.imageName)
        }
      } catch (err) {
        this.logger.error(`Failed to cleanup original image ${savedImage.imageName}: ${fromAxiosError(err)}`)
      }
    }

    if (runnerArtifactCache) {
      runnerArtifactCache.state = RunnerArtifactCacheState.READY
      await this.runnerArtifactCacheRepository.save(runnerArtifactCache)
    } else {
      await this.runnerService.createRunnerArtifactCacheEntry(
        runner.id,
        savedImage.artifactRef,
        RunnerArtifactCacheState.READY,
      )
    }
    await this.updateSavedImageState(savedImage.id, SavedImageState.ACTIVE)

    // Best effort removal of old source image from transient registry
    const transientRegistry = await this.dockerRegistryService.findTransientRegistryBySavedImageImageName(
      savedImage.imageName,
      runner.region,
    )
    if (transientRegistry) {
      try {
        await this.dockerRegistryService.removeImage(savedImage.imageName, transientRegistry.id)
      } catch (error) {
        if (error.statusCode === 404) {
          //  image not found, just return
          return DONT_SYNC_AGAIN
        }
        this.logger.error('Failed to remove transient image:', fromAxiosError(error))
      }
    }

    return DONT_SYNC_AGAIN
  }

  async processPullOnInitialRunner(savedImage: SavedImage, runner: Runner) {
    // Check for timeout - allow up to 30 minutes
    const timeoutMinutes = 30
    const timeoutMs = timeoutMinutes * 60 * 1000
    if (Date.now() - savedImage.updatedAt.getTime() > timeoutMs) {
      await this.updateSavedImageState(
        savedImage.id,
        SavedImageState.ERROR,
        'Timeout processing saved image artifact pull on initial runner',
      )
      return DONT_SYNC_AGAIN
    }

    let sourceRegistry = await this.dockerRegistryService.findSourceRegistryBySavedImageImageName(
      savedImage.imageName,
      runner.region,
      savedImage.organizationId,
    )
    if (!sourceRegistry) {
      sourceRegistry = await this.dockerRegistryService.getDefaultDockerHubRegistry()
    }
    const destinationRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(runner.region)

    // Fire pull request (runner returns 202 immediately)
    // Post-processing (digest, cleanup) is handled by handleCheckInitialRunnerSavedImageArtifact on the next poll cycle
    try {
      await this.pullRunnerArtifactCache(
        runner,
        savedImage.imageName,
        sourceRegistry,
        destinationRegistry ?? undefined,
        savedImage.artifactRef ? savedImage.artifactRef : undefined,
      )
    } catch (err) {
      // Validation errors are still returned synchronously
      await this.updateSavedImageState(savedImage.id, SavedImageState.ERROR, err.message)
      throw err
    }
  }

  async processBuildOnRunner(savedImage: SavedImage, runner: Runner) {
    try {
      const registry = await this.dockerRegistryService.getAvailableInternalRegistry(runner.region)

      const sourceRegistries = await this.dockerRegistryService.getSourceRegistriesForDockerfile(
        savedImage.buildInfo.dockerfileContent,
        savedImage.organizationId,
      )

      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      registry.url = registry.url.replace(/^(https?:\/\/)/, '')
      // Runner returns immediately; polling for completion is handled by handleCheckInitialRunnerSavedImageArtifact
      await runnerAdapter.buildArtifact(
        savedImage.buildInfo,
        savedImage.organizationId,
        sourceRegistries.length > 0 ? sourceRegistries : undefined,
        registry ?? undefined,
        true,
      )
    } catch (err) {
      this.logger.error(`Error building savedImage ${savedImage.name}: ${fromAxiosError(err)}`)
      await this.updateSavedImageState(savedImage.id, SavedImageState.BUILD_FAILED, fromAxiosError(err).message)
    }
  }

  async handleSavedImageStatePending(savedImage: SavedImage): Promise<SyncState> {
    let initialRunner: Runner | undefined = undefined

    if (!savedImage.initialRunnerId) {
      // TODO: get only runners where the base artifact is available (extract from buildInfo)
      const excludedRunnerIds = savedImage.buildInfo
        ? await this.runnerService.getRunnersWithMultipleArtifactsBuilding()
        : await this.runnerService.getRunnersWithMultipleArtifactsPulling()

      try {
        const regions = await this.savedImageService.getSavedImageRegions(savedImage.id)
        if (!regions.length) {
          throw new Error('No regions found for savedImage')
        }

        initialRunner = await this.runnerService.getRandomAvailableRunner({
          regions: regions.map((region) => region.id),
          excludedRunnerIds: excludedRunnerIds,
        })
      } catch (error) {
        this.logger.warn(`Failed to get initial runner: ${fromAxiosError(error)}`)
      }

      if (!initialRunner) {
        // No runners available, retry later
        return DONT_SYNC_AGAIN
      }

      savedImage.initialRunnerId = initialRunner.id
      await this.savedImageRepository.save(savedImage)
    } else {
      initialRunner = await this.runnerService.findOneOrFail(savedImage.initialRunnerId)
    }

    if (savedImage.buildInfo) {
      await this.updateSavedImageState(savedImage.id, SavedImageState.BUILDING)
      await this.runnerService.createRunnerArtifactCacheEntry(
        initialRunner.id,
        savedImage.buildInfo.artifactRef,
        RunnerArtifactCacheState.BUILDING_ARTIFACT,
      )
      await this.processBuildOnRunner(savedImage, initialRunner)
    } else {
      if (!savedImage.artifactRef) {
        const runnerAdapter = await this.runnerAdapterFactory.create(initialRunner)
        const registry = await this.dockerRegistryService.findRegistryByImageName(
          savedImage.imageName,
          initialRunner.region,
          savedImage.organizationId,
        )

        const image = parseDockerImage(savedImage.imageName)
        if (registry && !image.registry) {
          image.registry = registry.url.replace(/^(https?:\/\/)/, '')
        }
        const imageName = image.getFullName()

        const internalRegistry = await this.dockerRegistryService.getAvailableInternalRegistry(initialRunner.region)
        if (!internalRegistry) {
          throw new Error('No internal registry found for saved image artifact')
        }

        const artifactDigestResponse = await runnerAdapter.inspectArtifactInRegistry(imageName, registry)
        const digestSyncState = await this.processSavedImageArtifactDigest(
          savedImage,
          internalRegistry,
          artifactDigestResponse.hash,
          artifactDigestResponse.sizeGB,
        )

        if (digestSyncState === DONT_SYNC_AGAIN) {
          return DONT_SYNC_AGAIN
        }

        await this.savedImageRepository.save(savedImage)
      }

      await this.updateSavedImageState(savedImage.id, SavedImageState.PULLING)
      await this.runnerService.createRunnerArtifactCacheEntry(
        initialRunner.id,
        savedImage.artifactRef,
        RunnerArtifactCacheState.PULLING_ARTIFACT,
      )
      await this.processPullOnInitialRunner(savedImage, initialRunner)
    }

    return SYNC_AGAIN
  }

  private async updateSavedImageState(
    savedImageId: string,
    state: SavedImageState,
    errorReason?: string,
    size?: number,
  ) {
    const partialUpdate: Partial<SavedImage> = {
      state,
    }

    if (state === SavedImageState.ACTIVE) {
      partialUpdate.lastUsedAt = new Date()
    }

    if (errorReason !== undefined) {
      partialUpdate.errorReason = errorReason
    }

    if (size !== undefined) {
      partialUpdate.size = size
    }

    const result = await this.savedImageRepository.update(
      {
        id: savedImageId,
      },
      partialUpdate,
    )

    if (!result.affected) {
      throw new NotFoundException(`SavedImage with ID ${savedImageId} not found`)
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'cleanup-old-buildinfo-runner-artifact-caches' })
  @TrackJobExecution()
  @LogExecution('cleanup-old-buildinfo-runner-artifact-caches')
  @WithInstrumentation()
  async cleanupOldBuildInfoRunnerArtifactCaches() {
    const lockKey = 'cleanup-old-buildinfo-runner-artifact-caches-lock'
    if (!(await this.redisLockProvider.lock(lockKey, 300))) {
      return
    }

    try {
      const staleEntries = await this.runnerArtifactCacheRepository
        .createQueryBuilder('sr')
        .select('sr.id')
        .innerJoin(BuildInfo, 'bi', 'sr."artifactRef" = bi."artifactRef"')
        .where('sr.state = :readyState', { readyState: RunnerArtifactCacheState.READY })
        .andWhere(
          `bi.lastUsedAt < now() - interval '${this.configService.getOrThrow('buildInfoRunnerArtifactCacheStalenessDays')} days'`,
        )
        .andWhere(
          `sr.updatedAt < now() - interval '${this.configService.getOrThrow('buildInfoRunnerArtifactCacheStalenessDays')} days'`,
        )
        .andWhere("sr.artifactRef LIKE 'boxlite-%'")
        .limit(500)
        .getMany()

      if (staleEntries.length === 0) {
        return
      }

      const ids = staleEntries.map((sr) => sr.id)
      const result = await this.runnerArtifactCacheRepository.update(
        { id: In(ids) },
        { state: RunnerArtifactCacheState.REMOVING },
      )

      if (result.affected > 0) {
        this.logger.debug(`Marked ${result.affected} RunnerArtifactCaches for removal due to unused BuildInfo`)
      }
    } catch (error) {
      this.logger.error(`Failed to mark old BuildInfo RunnerArtifactCaches for removal: ${fromAxiosError(error)}`)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'deactivate-old-savedImages' })
  @TrackJobExecution()
  @LogExecution('deactivate-old-savedImages')
  @WithInstrumentation()
  async deactivateOldSavedImages() {
    const lockKey = 'deactivate-old-savedImages-lock'
    if (!(await this.redisLockProvider.lock(lockKey, 300))) {
      return
    }

    try {
      const cutoff = `NOW() - INTERVAL '1 minute' * COALESCE(org."saved_image_deactivation_timeout_minutes", ${DEFAULT_SAVED_IMAGE_DEACTIVATION_TIMEOUT_MINUTES})`

      const oldSavedImages = await this.savedImageRepository
        .createQueryBuilder('saved_image')
        .leftJoin('organization', 'org', `org."id" = saved_image."organizationId"`)
        .where('saved_image.general = false')
        .andWhere('saved_image.state = :savedImageState', { savedImageState: SavedImageState.ACTIVE })
        .andWhere(`(saved_image."lastUsedAt" IS NULL OR saved_image."lastUsedAt" < ${cutoff})`)
        .andWhere(`saved_image."createdAt" < ${cutoff}`)
        .andWhere(
          `NOT EXISTS (
            SELECT 1 FROM saved_image s
            WHERE s."artifactRef" = saved_image."artifactRef"
            AND s.state = :activeState
            AND (s."lastUsedAt" >= ${cutoff} OR s."createdAt" >= ${cutoff})
          )`,
          {
            activeState: SavedImageState.ACTIVE,
          },
        )
        .take(100)
        .getMany()

      if (oldSavedImages.length === 0) {
        return
      }

      const savedImageIds = oldSavedImages.map((savedImage) => savedImage.id)
      await this.savedImageRepository.update({ id: In(savedImageIds) }, { state: SavedImageState.INACTIVE })

      const refs = oldSavedImages.map((savedImage) => savedImage.artifactRef).filter((name) => name)

      if (refs.length > 0) {
        // Set associated RunnerArtifactCache records to REMOVING state
        const result = await this.runnerArtifactCacheRepository.update(
          { artifactRef: In(refs) },
          { state: RunnerArtifactCacheState.REMOVING },
        )

        this.logger.debug(
          `Deactivated ${oldSavedImages.length} savedImages and marked ${result.affected} RunnerArtifactCaches for removal`,
        )
      }
    } catch (error) {
      this.logger.error(`Failed to deactivate old savedImages: ${fromAxiosError(error)}`)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'cleanup-inactive-savedImages-from-runners' })
  @TrackJobExecution()
  @LogExecution('cleanup-inactive-savedImages-from-runners')
  @WithInstrumentation()
  async cleanupInactiveSavedImagesFromRunners() {
    const lockKey = 'cleanup-inactive-savedImages-from-runners-lock'
    if (!(await this.redisLockProvider.lock(lockKey, 300))) {
      return
    }

    try {
      // Only fetch inactive savedImages that have associated runner artifact cache entries
      const queryResult = await this.savedImageRepository
        .createQueryBuilder('saved_image')
        .select('saved_image."artifactRef"', 'artifactRef')
        .where('saved_image.state = :savedImageState', { savedImageState: SavedImageState.INACTIVE })
        .andWhere('saved_image."artifactRef" IS NOT NULL')
        .andWhereExists(
          this.runnerArtifactCacheRepository
            .createQueryBuilder('runner_artifact_cache')
            .select('1')
            .where('runner_artifact_cache."artifactRef" = saved_image."artifactRef"')
            .andWhere('runner_artifact_cache.state != :runnerArtifactCacheState', {
              runnerArtifactCacheState: RunnerArtifactCacheState.REMOVING,
            }),
        )
        .andWhere(
          () => {
            const query = this.savedImageRepository
              .createQueryBuilder('s')
              .select('1')
              .where('s."artifactRef" = saved_image."artifactRef"')
              .andWhere('s.state = :savedImageState')
            return `NOT EXISTS (${query.getQuery()})`
          },
          {
            savedImageState: SavedImageState.ACTIVE,
          },
        )
        .take(100)
        .getRawMany()

      const inactiveArtifactRefs = queryResult.map((result) => result.artifactRef)

      if (inactiveArtifactRefs.length > 0) {
        // Set associated RunnerArtifactCache records to REMOVING state
        const result = await this.runnerArtifactCacheRepository.update(
          { artifactRef: In(inactiveArtifactRefs) },
          { state: RunnerArtifactCacheState.REMOVING },
        )

        this.logger.debug(`Marked ${result.affected} RunnerArtifactCaches for removal`)
      }
    } catch (error) {
      this.logger.error(`Failed to cleanup inactive savedImages from runners: ${fromAxiosError(error)}`)
    } finally {
      await this.redisLockProvider.unlock(lockKey)
    }
  }

  private async processSavedImageArtifactDigest(
    savedImage: SavedImage,
    internalRegistry: DockerRegistry,
    hash: string,
    sizeGB?: number,
    entrypoint?: string[] | string,
  ): Promise<SyncState | void> {
    let shouldSave = false

    if (!savedImage.artifactRef) {
      shouldSave = true
      savedImage.artifactRef = createBoxLiteInternalArtifactRef(internalRegistry.url, internalRegistry.project, hash)
    }

    if (savedImage.size == null && typeof sizeGB === 'number') {
      shouldSave = true

      const organization = await this.organizationService.findOne(savedImage.organizationId)
      if (!organization) {
        throw new NotFoundException(`Organization with ID ${savedImage.organizationId} not found`)
      }

      const MAX_SIZE_GB = organization.maxSavedImageSize

      savedImage.size = sizeGB

      if (sizeGB > MAX_SIZE_GB) {
        await this.updateSavedImageState(
          savedImage.id,
          SavedImageState.ERROR,
          `SavedImage size (${sizeGB.toFixed(2)}GB) exceeds maximum allowed size of ${MAX_SIZE_GB}GB`,
          sizeGB,
        )
        return DONT_SYNC_AGAIN
      }
    }

    // If entrypoint is not explicitly set, set it from the artifact metadata.
    if (!savedImage.entrypoint) {
      if (entrypoint && entrypoint.length > 0) {
        shouldSave = true
        if (Array.isArray(entrypoint)) {
          savedImage.entrypoint = entrypoint
        } else {
          savedImage.entrypoint = [entrypoint]
        }
      }
    }

    if (shouldSave) {
      await this.savedImageRepository.save(savedImage)
    }
  }

  @OnAsyncEvent({
    event: SavedImageEvents.CREATED,
  })
  private async handleSavedImageCreatedEvent(event: SavedImageCreatedEvent) {
    await this.syncSavedImageState(event.savedImage.id)
  }

  @OnAsyncEvent({
    event: SavedImageEvents.ACTIVATED,
  })
  private async handleSavedImageActivatedEvent(event: SavedImageActivatedEvent) {
    await this.syncSavedImageState(event.savedImage.id)
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, IsNull, Not } from 'typeorm'
import {
  RunnerAdapter,
  RunnerInfo,
  RunnerBoxInfo,
  RunnerSnapshotInfo,
  StartBoxResponse,
  SnapshotDigestResponse,
} from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { BoxRepository } from '../repositories/box.repository'
import {
  CreateBoxDTO,
  CreateBackupDTO,
  BuildSnapshotRequestDTO,
  PullSnapshotRequestDTO,
  UpdateNetworkSettingsDTO,
  InspectSnapshotInRegistryRequest,
  RecoverBoxDTO,
} from '@boxlite-ai/runner-api-client'
import { SnapshotStateError } from '../errors/snapshot-state-error'

/**
 * RunnerAdapterV2 implements RunnerAdapter for v2 runners.
 * Instead of making direct API calls to the runner, it creates jobs in the database
 * that the v2 runner polls and processes asynchronously.
 */
@Injectable()
export class RunnerAdapterV2 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV2.name)
  private runner: Runner

  constructor(
    private readonly boxRepository: BoxRepository,
    @InjectRepository(Job)
    private readonly jobRepository: Repository<Job>,
    private readonly jobService: JobService,
  ) {}

  async init(runner: Runner): Promise<void> {
    this.runner = runner
  }

  async healthCheck(_signal?: AbortSignal): Promise<void> {
    throw new Error('healthCheck is not supported for V2 runners')
  }

  async runnerInfo(_signal?: AbortSignal): Promise<RunnerInfo> {
    throw new Error('runnerInfo is not supported for V2 runners')
  }

  async boxInfo(boxId: string): Promise<RunnerBoxInfo> {
    // Query the box entity
    const box = await this.boxRepository.findOne({
      where: { id: boxId },
    })

    if (!box) {
      throw new Error(`Box ${boxId} not found`)
    }

    // Query for any incomplete jobs for this box to determine transitional state
    const incompleteJob = await this.jobRepository.findOne({
      where: {
        resourceType: ResourceType.BOX,
        resourceId: boxId,
        completedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    })

    let state = box.state

    let daemonVersion: string | undefined = undefined

    // If there's an incomplete job, infer the transitional state from job type
    if (incompleteJob) {
      state = this.inferStateFromJob(incompleteJob, box)
      daemonVersion = incompleteJob.getResultMetadata()?.daemonVersion
    } else {
      // Look for latest job for this box
      const latestJob = await this.jobRepository.findOne({
        where: {
          resourceType: ResourceType.BOX,
          resourceId: boxId,
        },
        order: { createdAt: 'DESC' },
      })
      if (latestJob) {
        state = this.inferStateFromJob(latestJob, box)
        daemonVersion = latestJob.getResultMetadata()?.daemonVersion
      }
    }

    return {
      state,
      backupState: box.backupState,
      backupErrorReason: box.backupErrorReason,
      daemonVersion,
    }
  }

  private inferStateFromJob(job: Job, box: Box): BoxState {
    // Map job types to transitional states
    switch (job.type) {
      case JobType.CREATE_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.CREATING
      case JobType.START_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.STARTING
      case JobType.STOP_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STOPPED : BoxState.STOPPING
      case JobType.DESTROY_BOX:
        return job.status === JobStatus.COMPLETED ? BoxState.DESTROYED : BoxState.DESTROYING
      default:
        // For other job types (backup, etc.), return current box state
        return box.state
    }
  }

  async createBox(
    box: Box,
    snapshotRef: string,
    registry?: DockerRegistry,
    entrypoint?: string[],
    metadata?: { [key: string]: string },
    otelEndpoint?: string,
    skipStart?: boolean,
  ): Promise<StartBoxResponse | undefined> {
    const payload: CreateBoxDTO = {
      id: box.id,
      userId: box.organizationId,
      snapshot: snapshotRef,
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: box.mem,
      storageQuota: box.disk,
      env: box.env,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
      entrypoint: entrypoint,
      volumes: box.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: box.networkBlockAll,
      networkAllowList: box.networkAllowList,
      metadata: metadata,
      authToken: box.authToken,
      otelEndpoint: otelEndpoint,
      skipStart: skipStart,
      organizationId: box.organizationId,
      regionId: box.region,
    }

    await this.jobService.createJob(null, JobType.CREATE_BOX, this.runner.id, ResourceType.BOX, box.id, payload)

    this.logger.debug(`Created CREATE_BOX job for box ${box.id} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartBoxResponse | undefined> {
    await this.jobService.createJob(null, JobType.START_BOX, this.runner.id, ResourceType.BOX, boxId, {
      authToken,
      metadata,
    })

    this.logger.debug(`Created START_BOX job for box ${boxId} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async stopBox(boxId: string, force?: boolean): Promise<void> {
    await this.jobService.createJob(null, JobType.STOP_BOX, this.runner.id, ResourceType.BOX, boxId, {
      force,
    })

    this.logger.debug(`Created STOP_BOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async destroyBox(boxId: string): Promise<void> {
    await this.jobService.createJob(null, JobType.DESTROY_BOX, this.runner.id, ResourceType.BOX, boxId)

    this.logger.debug(`Created DESTROY_BOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async recoverBox(box: Box): Promise<void> {
    const recoverBoxDTO: RecoverBoxDTO = {
      userId: box.organizationId,
      snapshot: box.snapshot,
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: box.mem,
      storageQuota: box.disk,
      env: box.env,
      volumes: box.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: box.networkBlockAll,
      networkAllowList: box.networkAllowList,
      errorReason: box.errorReason,
      backupErrorReason: box.backupErrorReason,
    }
    await this.jobService.createJob(null, JobType.RECOVER_BOX, this.runner.id, ResourceType.BOX, box.id, recoverBoxDTO)

    this.logger.debug(`Created RECOVER_BOX job for box ${box.id} on runner ${this.runner.id}`)
  }

  async createBackup(box: Box, backupSnapshotName: string, registry?: DockerRegistry): Promise<void> {
    const payload: CreateBackupDTO = {
      snapshot: backupSnapshotName,
      registry: undefined,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(null, JobType.CREATE_BACKUP, this.runner.id, ResourceType.BOX, box.id, payload)

    this.logger.debug(`Created CREATE_BACKUP job for box ${box.id} on runner ${this.runner.id}`)
  }

  async buildSnapshot(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void> {
    const payload: BuildSnapshotRequestDTO = {
      snapshot: buildInfo.snapshotRef,
      dockerfile: buildInfo.dockerfileContent,
      organizationId: organizationId,
      context: buildInfo.contextHashes,
      pushToInternalRegistry: pushToInternalRegistry,
    }

    if (sourceRegistries) {
      payload.sourceRegistries = sourceRegistries.map((sourceRegistry) => ({
        project: sourceRegistry.project,
        url: sourceRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: sourceRegistry.username,
        password: sourceRegistry.password,
      }))
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(
      null,
      JobType.BUILD_SNAPSHOT,
      this.runner.id,
      ResourceType.SNAPSHOT,
      buildInfo.snapshotRef,
      payload,
    )

    this.logger.debug(`Created BUILD_SNAPSHOT job for ${buildInfo.snapshotRef} on runner ${this.runner.id}`)
  }

  async pullSnapshot(
    snapshotName: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
  ): Promise<void> {
    const payload: PullSnapshotRequestDTO = {
      snapshot: snapshotName,
      newTag,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    if (destinationRegistry) {
      payload.destinationRegistry = {
        project: destinationRegistry.project,
        url: destinationRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: destinationRegistry.username,
        password: destinationRegistry.password,
      }
    }

    if (destinationRef) {
      payload.destinationRef = destinationRef
    }

    await this.jobService.createJob(
      null,
      JobType.PULL_SNAPSHOT,
      this.runner.id,
      ResourceType.SNAPSHOT,
      destinationRef || snapshotName,
      payload,
    )

    this.logger.debug(`Created PULL_SNAPSHOT job for ${snapshotName} on runner ${this.runner.id}`)
  }

  async removeSnapshot(snapshotName: string): Promise<void> {
    await this.jobService.createJob(null, JobType.REMOVE_SNAPSHOT, this.runner.id, ResourceType.SNAPSHOT, snapshotName)

    this.logger.debug(`Created REMOVE_SNAPSHOT job for ${snapshotName} on runner ${this.runner.id}`)
  }

  async snapshotExists(snapshotRef: string): Promise<boolean> {
    // Find the latest job for this snapshot on this runner
    // Do not include INSPECT_SNAPSHOT_IN_REGISTRY
    const latestJob = await this.jobRepository.findOne({
      where: [
        {
          runnerId: this.runner.id,
          resourceType: ResourceType.SNAPSHOT,
          resourceId: snapshotRef,
          type: Not(JobType.INSPECT_SNAPSHOT_IN_REGISTRY),
        },
      ],
      order: { createdAt: 'DESC' },
    })

    // If no job exists, snapshot doesn't exist
    if (!latestJob) {
      return false
    }

    // If the latest job is a REMOVE_SNAPSHOT, the snapshot no longer exists
    if (latestJob.type === JobType.REMOVE_SNAPSHOT) {
      return false
    }

    // If the latest job is PULL_SNAPSHOT or BUILD_SNAPSHOT, check if it completed successfully
    if (latestJob.type === JobType.PULL_SNAPSHOT || latestJob.type === JobType.BUILD_SNAPSHOT) {
      return latestJob.status === JobStatus.COMPLETED
    }

    // For any other job type, snapshot doesn't exist
    return false
  }

  async getSnapshotInfo(snapshotRef: string): Promise<RunnerSnapshotInfo> {
    const latestJob = await this.jobRepository.findOne({
      where: [
        {
          runnerId: this.runner.id,
          resourceType: ResourceType.SNAPSHOT,
          resourceId: snapshotRef,
          type: Not(JobType.INSPECT_SNAPSHOT_IN_REGISTRY),
        },
      ],
      order: { createdAt: 'DESC' },
    })

    if (!latestJob) {
      throw new Error(`Snapshot ${snapshotRef} not found on runner ${this.runner.id}`)
    }

    const metadata = latestJob.getResultMetadata()

    switch (latestJob.status) {
      case JobStatus.COMPLETED:
        if (latestJob.type === JobType.PULL_SNAPSHOT || latestJob.type === JobType.BUILD_SNAPSHOT) {
          return {
            name: latestJob.resourceId,
            sizeGB: metadata?.sizeGB,
            entrypoint: metadata?.entrypoint,
            cmd: metadata?.cmd,
            hash: metadata?.hash,
          }
        }
        throw new Error(
          `Snapshot ${snapshotRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
      case JobStatus.FAILED:
        throw new SnapshotStateError(
          latestJob.errorMessage || `Snapshot ${snapshotRef} failed on runner ${this.runner.id}`,
        )
      default:
        throw new Error(
          `Snapshot ${snapshotRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
    }
  }

  async inspectSnapshotInRegistry(snapshotName: string, registry?: DockerRegistry): Promise<SnapshotDigestResponse> {
    const payload: InspectSnapshotInRegistryRequest = {
      snapshot: snapshotName,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    }

    const job = await this.jobService.createJob(
      null,
      JobType.INSPECT_SNAPSHOT_IN_REGISTRY,
      this.runner.id,
      ResourceType.SNAPSHOT,
      snapshotName,
      payload,
    )

    this.logger.debug(`Created INSPECT_SNAPSHOT_IN_REGISTRY job for ${snapshotName} on runner ${this.runner.id}`)

    const waitTimeout = 30 * 1000 // 30 seconds
    const completedJob = await this.jobService.waitJobCompletion(job.id, waitTimeout)

    if (!completedJob) {
      throw new Error(`Snapshot ${snapshotName} not found in registry on runner ${this.runner.id}`)
    }

    if (completedJob.status !== JobStatus.COMPLETED) {
      throw new Error(
        `Snapshot ${snapshotName} failed to inspect in registry on runner ${this.runner.id}. Error: ${completedJob.errorMessage}`,
      )
    }

    const resultMetadata = completedJob.getResultMetadata()

    return {
      hash: resultMetadata?.hash,
      sizeGB: resultMetadata?.sizeGB,
    }
  }

  async updateNetworkSettings(
    boxId: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    networkLimitEgress?: boolean,
  ): Promise<void> {
    const payload: UpdateNetworkSettingsDTO = {
      networkBlockAll: networkBlockAll,
      networkAllowList: networkAllowList,
      networkLimitEgress: networkLimitEgress,
    }

    await this.jobService.createJob(
      null,
      JobType.UPDATE_BOX_NETWORK_SETTINGS,
      this.runner.id,
      ResourceType.BOX,
      boxId,
      payload,
    )

    this.logger.debug(`Created UPDATE_BOX_NETWORK_SETTINGS job for box ${boxId} on runner ${this.runner.id}`)
  }

  async resizeBox(boxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.jobService.createJob(null, JobType.RESIZE_BOX, this.runner.id, ResourceType.BOX, boxId, {
      cpu,
      memory,
      disk,
    })

    this.logger.debug(`Created RESIZE_BOX job for box ${boxId} on runner ${this.runner.id}`)
  }
}

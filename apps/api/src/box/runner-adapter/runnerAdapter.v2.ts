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
  StartBoxResponse,
  ArtifactDigestResponse,
} from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { BoxRepository } from '../repositories/box.repository'
import {
  CreateBoxDTO,
  UpdateNetworkSettingsDTO,
  InspectArtifactInRegistryRequest,
  RecoverBoxDTO,
} from '@boxlite-ai/runner-api-client'

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
        resourceType: ResourceType.SANDBOX,
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
          resourceType: ResourceType.SANDBOX,
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
      daemonVersion,
    }
  }

  private inferStateFromJob(job: Job, box: Box): BoxState {
    // Map job types to transitional states
    switch (job.type) {
      case JobType.CREATE_SANDBOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.CREATING
      case JobType.START_SANDBOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STARTED : BoxState.STARTING
      case JobType.STOP_SANDBOX:
        return job.status === JobStatus.COMPLETED ? BoxState.STOPPED : BoxState.STOPPING
      case JobType.DESTROY_SANDBOX:
        return job.status === JobStatus.COMPLETED ? BoxState.DESTROYED : BoxState.DESTROYING
      default:
        // For other job types (backup, etc.), return current box state
        return box.state
    }
  }

  async createBox(
    box: Box,
    artifactRef: string,
    entrypoint?: string[],
    metadata?: { [key: string]: string },
    otelEndpoint?: string,
    skipStart?: boolean,
  ): Promise<StartBoxResponse | undefined> {
    const payload: CreateBoxDTO = {
      id: box.id,
      boxId: box.boxId,
      userId: box.organizationId,
      artifactRef,
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: box.mem,
      storageQuota: box.disk,
      env: box.env,
      entrypoint: entrypoint,
      volumes: box.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: box.networkBlockAll,
      networkAllowList: box.networkAllowList,
      metadata: { ...(metadata ?? {}), boxId: box.boxId },
      authToken: box.authToken,
      otelEndpoint: otelEndpoint,
      skipStart: skipStart,
      organizationId: box.organizationId,
      regionId: box.region,
    }

    await this.jobService.createJob(null, JobType.CREATE_SANDBOX, this.runner.id, ResourceType.SANDBOX, box.id, payload)

    this.logger.debug(`Created CREATE_SANDBOX job for box ${box.id} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartBoxResponse | undefined> {
    await this.jobService.createJob(null, JobType.START_SANDBOX, this.runner.id, ResourceType.SANDBOX, boxId, {
      authToken,
      metadata,
    })

    this.logger.debug(`Created START_SANDBOX job for box ${boxId} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async stopBox(boxId: string, force?: boolean): Promise<void> {
    await this.jobService.createJob(null, JobType.STOP_SANDBOX, this.runner.id, ResourceType.SANDBOX, boxId, {
      force,
    })

    this.logger.debug(`Created STOP_SANDBOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async destroyBox(boxId: string): Promise<void> {
    await this.jobService.createJob(null, JobType.DESTROY_SANDBOX, this.runner.id, ResourceType.SANDBOX, boxId)

    this.logger.debug(`Created DESTROY_SANDBOX job for box ${boxId} on runner ${this.runner.id}`)
  }

  async recoverBox(box: Box): Promise<void> {
    const recoverBoxDTO: RecoverBoxDTO = {
      userId: box.organizationId,
      snapshot: box.template,
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
    }
    await this.jobService.createJob(
      null,
      JobType.RECOVER_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      box.id,
      recoverBoxDTO,
    )

    this.logger.debug(`Created RECOVER_SANDBOX job for box ${box.id} on runner ${this.runner.id}`)
  }

  // TODO(image-rewrite): pullArtifact removed with runner_artifact_cache + box_template.

  async removeArtifact(artifactRef: string): Promise<void> {
    await this.jobService.createJob(null, JobType.REMOVE_ARTIFACT, this.runner.id, ResourceType.ARTIFACT, artifactRef)

    this.logger.debug(`Created REMOVE_ARTIFACT job for ${artifactRef} on runner ${this.runner.id}`)
  }

  async artifactExists(artifactRef: string): Promise<boolean> {
    // Find the latest artifact job for this runner.
    // Do not include INSPECT_ARTIFACT_IN_REGISTRY
    const latestJob = await this.jobRepository.findOne({
      where: [
        {
          runnerId: this.runner.id,
          resourceType: ResourceType.ARTIFACT,
          resourceId: artifactRef,
          type: Not(JobType.INSPECT_ARTIFACT_IN_REGISTRY),
        },
      ],
      order: { createdAt: 'DESC' },
    })

    // If no job exists, the artifact doesn't exist.
    if (!latestJob) {
      return false
    }

    // If the latest job is a REMOVE_ARTIFACT, the artifact no longer exists.
    if (latestJob.type === JobType.REMOVE_ARTIFACT) {
      return false
    }

    // If the latest job is PULL_ARTIFACT, check if it completed successfully
    if (latestJob.type === JobType.PULL_ARTIFACT) {
      return latestJob.status === JobStatus.COMPLETED
    }

    // For any other job type, the artifact doesn't exist.
    return false
  }

  // TODO(image-rewrite): getArtifactInfo removed with runner_artifact_cache + box_template.

  async inspectArtifactInRegistry(artifactRef: string): Promise<ArtifactDigestResponse> {
    const payload: InspectArtifactInRegistryRequest = {
      artifactRef,
    }

    const job = await this.jobService.createJob(
      null,
      JobType.INSPECT_ARTIFACT_IN_REGISTRY,
      this.runner.id,
      ResourceType.ARTIFACT,
      artifactRef,
      payload,
    )

    this.logger.debug(`Created INSPECT_ARTIFACT_IN_REGISTRY job for ${artifactRef} on runner ${this.runner.id}`)

    const waitTimeout = 30 * 1000 // 30 seconds
    const completedJob = await this.jobService.waitJobCompletion(job.id, waitTimeout)

    if (!completedJob) {
      throw new Error(`Runtime artifact ${artifactRef} not found in registry on runner ${this.runner.id}`)
    }

    if (completedJob.status !== JobStatus.COMPLETED) {
      throw new Error(
        `Runtime artifact ${artifactRef} failed to inspect in registry on runner ${this.runner.id}. Error: ${completedJob.errorMessage}`,
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
      JobType.UPDATE_SANDBOX_NETWORK_SETTINGS,
      this.runner.id,
      ResourceType.SANDBOX,
      boxId,
      payload,
    )

    this.logger.debug(`Created UPDATE_SANDBOX_NETWORK_SETTINGS job for box ${boxId} on runner ${this.runner.id}`)
  }

  async resizeBox(boxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.jobService.createJob(null, JobType.RESIZE_SANDBOX, this.runner.id, ResourceType.SANDBOX, boxId, {
      cpu,
      memory,
      disk,
    })

    this.logger.debug(`Created RESIZE_SANDBOX job for box ${boxId} on runner ${this.runner.id}`)
  }
}

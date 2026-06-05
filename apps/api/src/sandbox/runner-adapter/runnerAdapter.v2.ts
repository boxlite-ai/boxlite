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
  RunnerSandboxInfo,
  RunnerArtifactInfo,
  StartSandboxResponse,
  ArtifactDigestResponse,
} from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Job } from '../entities/job.entity'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { SandboxRepository } from '../repositories/sandbox.repository'
import {
  CreateSandboxDTO,
  CreateBackupDTO,
  BuildArtifactRequestDTO,
  PullArtifactRequestDTO,
  UpdateNetworkSettingsDTO,
  InspectArtifactInRegistryRequest,
  RecoverSandboxDTO,
} from '@boxlite-ai/runner-api-client'
import { RuntimeArtifactStateError } from '../errors/runtime-artifact-state-error'

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
    private readonly sandboxRepository: SandboxRepository,
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

  async sandboxInfo(sandboxId: string): Promise<RunnerSandboxInfo> {
    // Query the sandbox entity
    const sandbox = await this.sandboxRepository.findOne({
      where: { id: sandboxId },
    })

    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    // Query for any incomplete jobs for this sandbox to determine transitional state
    const incompleteJob = await this.jobRepository.findOne({
      where: {
        resourceType: ResourceType.SANDBOX,
        resourceId: sandboxId,
        completedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    })

    let state = sandbox.state

    let daemonVersion: string | undefined = undefined

    // If there's an incomplete job, infer the transitional state from job type
    if (incompleteJob) {
      state = this.inferStateFromJob(incompleteJob, sandbox)
      daemonVersion = incompleteJob.getResultMetadata()?.daemonVersion
    } else {
      // Look for latest job for this sandbox
      const latestJob = await this.jobRepository.findOne({
        where: {
          resourceType: ResourceType.SANDBOX,
          resourceId: sandboxId,
        },
        order: { createdAt: 'DESC' },
      })
      if (latestJob) {
        state = this.inferStateFromJob(latestJob, sandbox)
        daemonVersion = latestJob.getResultMetadata()?.daemonVersion
      }
    }

    return {
      state,
      backupState: sandbox.backupState,
      backupErrorReason: sandbox.backupErrorReason,
      daemonVersion,
    }
  }

  private inferStateFromJob(job: Job, sandbox: Sandbox): SandboxState {
    // Map job types to transitional states
    switch (job.type) {
      case JobType.CREATE_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.STARTED : SandboxState.CREATING
      case JobType.START_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.STARTED : SandboxState.STARTING
      case JobType.STOP_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.STOPPED : SandboxState.STOPPING
      case JobType.DESTROY_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.DESTROYED : SandboxState.DESTROYING
      default:
        // For other job types (backup, etc.), return current sandbox state
        return sandbox.state
    }
  }

  async createSandbox(
    sandbox: Sandbox,
    artifactRef: string,
    registry?: DockerRegistry,
    entrypoint?: string[],
    metadata?: { [key: string]: string },
    otelEndpoint?: string,
    skipStart?: boolean,
  ): Promise<StartSandboxResponse | undefined> {
    const payload: CreateSandboxDTO = {
      id: sandbox.id,
      userId: sandbox.organizationId,
      artifactRef,
      osUser: sandbox.osUser,
      cpuQuota: sandbox.cpu,
      gpuQuota: sandbox.gpu,
      memoryQuota: sandbox.mem,
      storageQuota: sandbox.disk,
      env: sandbox.env,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url,
            username: registry.username,
            password: registry.password,
          }
        : undefined,
      entrypoint: entrypoint,
      volumes: sandbox.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: sandbox.networkBlockAll,
      networkAllowList: sandbox.networkAllowList,
      metadata: metadata,
      authToken: sandbox.authToken,
      otelEndpoint: otelEndpoint,
      skipStart: skipStart,
      organizationId: sandbox.organizationId,
      regionId: sandbox.region,
    }

    await this.jobService.createJob(
      null,
      JobType.CREATE_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      payload,
    )

    this.logger.debug(`Created CREATE_SANDBOX job for sandbox ${sandbox.id} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async startSandbox(
    sandboxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartSandboxResponse | undefined> {
    await this.jobService.createJob(null, JobType.START_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      authToken,
      metadata,
    })

    this.logger.debug(`Created START_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async stopSandbox(sandboxId: string, force?: boolean): Promise<void> {
    await this.jobService.createJob(null, JobType.STOP_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      force,
    })

    this.logger.debug(`Created STOP_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.jobService.createJob(null, JobType.DESTROY_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId)

    this.logger.debug(`Created DESTROY_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async recoverSandbox(sandbox: Sandbox): Promise<void> {
    const recoverSandboxDTO: RecoverSandboxDTO = {
      userId: sandbox.organizationId,
      snapshot: sandbox.template,
      osUser: sandbox.osUser,
      cpuQuota: sandbox.cpu,
      gpuQuota: sandbox.gpu,
      memoryQuota: sandbox.mem,
      storageQuota: sandbox.disk,
      env: sandbox.env,
      volumes: sandbox.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: sandbox.networkBlockAll,
      networkAllowList: sandbox.networkAllowList,
      errorReason: sandbox.errorReason,
      backupErrorReason: sandbox.backupErrorReason,
    }
    await this.jobService.createJob(
      null,
      JobType.RECOVER_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      recoverSandboxDTO,
    )

    this.logger.debug(`Created RECOVER_SANDBOX job for sandbox ${sandbox.id} on runner ${this.runner.id}`)
  }

  async createBackup(sandbox: Sandbox, backupSnapshotName: string, registry?: DockerRegistry): Promise<void> {
    const payload: CreateBackupDTO = {
      snapshot: backupSnapshotName,
      registry: undefined,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(
      null,
      JobType.CREATE_BACKUP,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      payload,
    )

    this.logger.debug(`Created CREATE_BACKUP job for sandbox ${sandbox.id} on runner ${this.runner.id}`)
  }

  async buildArtifact(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void> {
    const payload: BuildArtifactRequestDTO = {
      artifactRef: buildInfo.artifactRef,
      dockerfile: buildInfo.dockerfileContent,
      organizationId: organizationId,
      context: buildInfo.contextHashes,
      pushToInternalRegistry: pushToInternalRegistry,
    }

    if (sourceRegistries) {
      payload.sourceRegistries = sourceRegistries.map((sourceRegistry) => ({
        project: sourceRegistry.project,
        url: sourceRegistry.url,
        username: sourceRegistry.username,
        password: sourceRegistry.password,
      }))
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(
      null,
      JobType.BUILD_ARTIFACT,
      this.runner.id,
      ResourceType.ARTIFACT,
      buildInfo.artifactRef,
      payload,
    )

    this.logger.debug(`Created BUILD_ARTIFACT job for ${buildInfo.artifactRef} on runner ${this.runner.id}`)
  }

  async pullArtifact(
    artifactRef: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
  ): Promise<void> {
    const payload: PullArtifactRequestDTO = {
      artifactRef,
      newTag,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    if (destinationRegistry) {
      payload.destinationRegistry = {
        project: destinationRegistry.project,
        url: destinationRegistry.url,
        username: destinationRegistry.username,
        password: destinationRegistry.password,
      }
    }

    if (destinationRef) {
      payload.destinationRef = destinationRef
    }

    await this.jobService.createJob(
      null,
      JobType.PULL_ARTIFACT,
      this.runner.id,
      ResourceType.ARTIFACT,
      destinationRef || artifactRef,
      payload,
    )

    this.logger.debug(`Created PULL_ARTIFACT job for ${artifactRef} on runner ${this.runner.id}`)
  }

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

    // If the latest job is PULL_ARTIFACT or BUILD_ARTIFACT, check if it completed successfully
    if (latestJob.type === JobType.PULL_ARTIFACT || latestJob.type === JobType.BUILD_ARTIFACT) {
      return latestJob.status === JobStatus.COMPLETED
    }

    // For any other job type, the artifact doesn't exist.
    return false
  }

  async getArtifactInfo(artifactRef: string): Promise<RunnerArtifactInfo> {
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

    if (!latestJob) {
      throw new Error(`BoxTemplate ${artifactRef} not found on runner ${this.runner.id}`)
    }

    const metadata = latestJob.getResultMetadata()

    switch (latestJob.status) {
      case JobStatus.COMPLETED:
        if (latestJob.type === JobType.PULL_ARTIFACT || latestJob.type === JobType.BUILD_ARTIFACT) {
          return {
            name: latestJob.resourceId,
            sizeGB: metadata?.sizeGB,
            entrypoint: metadata?.entrypoint,
            cmd: metadata?.cmd,
            hash: metadata?.hash,
          }
        }
        throw new Error(
          `BoxTemplate ${artifactRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
      case JobStatus.FAILED:
        throw new RuntimeArtifactStateError(
          latestJob.errorMessage || `BoxTemplate ${artifactRef} failed on runner ${this.runner.id}`,
        )
      default:
        throw new Error(
          `BoxTemplate ${artifactRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
    }
  }

  async inspectArtifactInRegistry(artifactRef: string, registry?: DockerRegistry): Promise<ArtifactDigestResponse> {
    const payload: InspectArtifactInRegistryRequest = {
      artifactRef,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url,
            username: registry.username,
            password: registry.password,
          }
        : undefined,
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
    sandboxId: string,
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
      sandboxId,
      payload,
    )

    this.logger.debug(
      `Created UPDATE_SANDBOX_NETWORK_SETTINGS job for sandbox ${sandboxId} on runner ${this.runner.id}`,
    )
  }

  async resizeSandbox(sandboxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.jobService.createJob(null, JobType.RESIZE_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      cpu,
      memory,
      disk,
    })

    this.logger.debug(`Created RESIZE_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }
}

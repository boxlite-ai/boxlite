/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { AxiosError } from 'axios'
import axiosDebug from 'axios-debug-log'
import axiosRetry from 'axios-retry'

import { Injectable, Logger } from '@nestjs/common'
import {
  RunnerAdapter,
  RunnerInfo,
  RunnerSandboxInfo,
  RunnerArtifactInfo,
  StartSandboxResponse,
  ArtifactDigestResponse,
} from './runnerAdapter'
import { RuntimeArtifactStateError } from '../errors/runtime-artifact-state-error'
import { Runner } from '../entities/runner.entity'
import {
  Configuration,
  SandboxApi,
  EnumsSandboxState,
  ArtifactsApi,
  EnumsBackupState,
  DefaultApi,
  CreateSandboxDTO,
  BuildArtifactRequestDTO,
  CreateBackupDTO,
  PullArtifactRequestDTO,
  UpdateNetworkSettingsDTO,
  InspectArtifactInRegistryRequest,
  RecoverSandboxDTO,
} from '@boxlite-ai/runner-api-client'
import { Sandbox } from '../entities/sandbox.entity'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { BackupState } from '../enums/backup-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'

const isDebugEnabled = process.env.DEBUG === 'true'

// Network error codes that should trigger a retry
const RETRYABLE_NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT']

@Injectable()
export class RunnerAdapterV0 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV0.name)
  private sandboxApiClient: SandboxApi
  private artifactApiClient: ArtifactsApi
  private runnerApiClient: DefaultApi

  private convertSandboxState(state: EnumsSandboxState): SandboxState {
    switch (state) {
      case EnumsSandboxState.SandboxStateCreating:
        return SandboxState.CREATING
      case EnumsSandboxState.SandboxStateRestoring:
        return SandboxState.RESTORING
      case EnumsSandboxState.SandboxStateDestroyed:
        return SandboxState.DESTROYED
      case EnumsSandboxState.SandboxStateDestroying:
        return SandboxState.DESTROYING
      case EnumsSandboxState.SandboxStateStarted:
        return SandboxState.STARTED
      case EnumsSandboxState.SandboxStateStopped:
        return SandboxState.STOPPED
      case EnumsSandboxState.SandboxStateStarting:
        return SandboxState.STARTING
      case EnumsSandboxState.SandboxStateStopping:
        return SandboxState.STOPPING
      case EnumsSandboxState.SandboxStateError:
        return SandboxState.ERROR
      case EnumsSandboxState.SandboxStatePullingArtifact:
        return SandboxState.PULLING_ARTIFACT
      default:
        return SandboxState.UNKNOWN
    }
  }

  private convertBackupState(state: EnumsBackupState): BackupState {
    switch (state) {
      case EnumsBackupState.BackupStatePending:
        return BackupState.PENDING
      case EnumsBackupState.BackupStateInProgress:
        return BackupState.IN_PROGRESS
      case EnumsBackupState.BackupStateCompleted:
        return BackupState.COMPLETED
      case EnumsBackupState.BackupStateFailed:
        return BackupState.ERROR
      default:
        return BackupState.NONE
    }
  }

  public async init(runner: Runner): Promise<void> {
    if (!runner.apiUrl) {
      throw new Error('Runner API URL is required')
    }

    const axiosInstance = axios.create({
      baseURL: runner.apiUrl,
      headers: {
        Authorization: `Bearer ${runner.apiKey}`,
      },
      timeout: 1 * 60 * 60 * 1000, // 1 hour
    })

    const retryErrorMap = new WeakMap<AxiosError, string>()

    // Configure axios-retry to handle network errors
    axiosRetry(axiosInstance, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        // Check if error code or message matches any retryable error
        const matchedErrorCode = RETRYABLE_NETWORK_ERROR_CODES.find(
          (code) =>
            (error as any).code === code || error.message?.includes(code) || (error as any).cause?.code === code,
        )

        if (matchedErrorCode) {
          retryErrorMap.set(error, matchedErrorCode)
          return true
        }

        return false
      },
      onRetry: (retryCount, error, requestConfig) => {
        this.logger.warn(
          `Retrying request due to ${retryErrorMap.get(error)} (attempt ${retryCount}): ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`,
        )
      },
    })

    axiosInstance.interceptors.response.use(
      (response) => {
        return response
      },
      (error) => {
        const errorMessage = error.response?.data?.message || error.response?.data || error.message || String(error)
        const statusCode = error.response?.data?.statusCode || error.response?.status || error.status
        const code = error.response?.data?.code || (error as any).code || (error as any).cause?.code || ''

        throw new RunnerApiError(String(errorMessage), statusCode, code)
      },
    )

    if (isDebugEnabled) {
      axiosDebug.addLogger(axiosInstance)
    }

    this.sandboxApiClient = new SandboxApi(new Configuration(), '', axiosInstance)
    this.artifactApiClient = new ArtifactsApi(new Configuration(), '', axiosInstance)
    this.runnerApiClient = new DefaultApi(new Configuration(), '', axiosInstance)
  }

  async healthCheck(signal?: AbortSignal): Promise<void> {
    const response = await this.runnerApiClient.healthCheck({ signal })
    if (response.data.status !== 'ok') {
      throw new Error('Runner is not healthy')
    }
  }

  async runnerInfo(signal?: AbortSignal): Promise<RunnerInfo> {
    const response = await this.runnerApiClient.runnerInfo({ signal })
    return {
      serviceHealth: response.data.serviceHealth,
      metrics: response.data.metrics,
      appVersion: response.data.appVersion,
    }
  }

  async sandboxInfo(sandboxId: string): Promise<RunnerSandboxInfo> {
    const sandboxInfo = await this.sandboxApiClient.info(sandboxId)
    return {
      state: this.convertSandboxState(sandboxInfo.data.state),
      backupState: this.convertBackupState(sandboxInfo.data.backupState),
      backupSnapshot: sandboxInfo.data.backupSnapshot,
      backupErrorReason: sandboxInfo.data.backupError,
      daemonVersion: sandboxInfo.data.daemonVersion,
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
    const createSandboxDto: CreateSandboxDTO = {
      id: sandbox.id,
      boxId: sandbox.boxId,
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
      metadata: { ...(metadata ?? {}), boxId: sandbox.boxId },
      authToken: sandbox.authToken,
      otelEndpoint,
      skipStart: skipStart,
      organizationId: sandbox.organizationId,
      regionId: sandbox.region,
    }

    const response = await this.sandboxApiClient.create(createSandboxDto)

    if (!response?.data?.daemonVersion) {
      return undefined
    }

    return {
      daemonVersion: response.data.daemonVersion,
    }
  }

  async startSandbox(
    sandboxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartSandboxResponse | undefined> {
    const response = await this.sandboxApiClient.start(sandboxId, authToken, metadata)

    if (!response?.data?.daemonVersion) {
      return undefined
    }

    return {
      daemonVersion: response.data.daemonVersion,
    }
  }

  async stopSandbox(sandboxId: string, force?: boolean): Promise<void> {
    await this.sandboxApiClient.stop(sandboxId, { force })
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.sandboxApiClient.destroy(sandboxId)
  }

  async createBackup(sandbox: Sandbox, backupSnapshotName: string, registry?: DockerRegistry): Promise<void> {
    const request: CreateBackupDTO = {
      snapshot: backupSnapshotName,
      registry: undefined,
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    await this.sandboxApiClient.createBackup(sandbox.id, request)
  }

  async buildArtifact(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void> {
    const request: BuildArtifactRequestDTO = {
      artifactRef: buildInfo.artifactRef,
      dockerfile: buildInfo.dockerfileContent,
      organizationId: organizationId,
      context: buildInfo.contextHashes,
      pushToInternalRegistry: pushToInternalRegistry,
    }

    if (sourceRegistries) {
      request.sourceRegistries = sourceRegistries.map((sourceRegistry) => ({
        project: sourceRegistry.project,
        url: sourceRegistry.url,
        username: sourceRegistry.username,
        password: sourceRegistry.password,
      }))
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    await this.artifactApiClient.buildArtifact(request)
  }

  async removeArtifact(artifactRef: string): Promise<void> {
    await this.artifactApiClient.removeArtifact(artifactRef)
  }

  async pullArtifact(
    artifactRef: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
  ): Promise<void> {
    const request: PullArtifactRequestDTO = {
      artifactRef,
      newTag,
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url,
        username: registry.username,
        password: registry.password,
      }
    }

    if (destinationRegistry) {
      request.destinationRegistry = {
        project: destinationRegistry.project,
        url: destinationRegistry.url,
        username: destinationRegistry.username,
        password: destinationRegistry.password,
      }
    }

    if (destinationRef) {
      request.destinationRef = destinationRef
    }

    await this.artifactApiClient.pullArtifact(request)
  }

  async artifactExists(artifactRef: string): Promise<boolean> {
    const response = await this.artifactApiClient.artifactExists(artifactRef)
    return response.data.exists
  }

  async getArtifactInfo(artifactRef: string): Promise<RunnerArtifactInfo> {
    try {
      const response = await this.artifactApiClient.getArtifactInfo(artifactRef)

      return {
        name: response.data.name || '',
        sizeGB: response.data.sizeGB,
        entrypoint: response.data.entrypoint,
        cmd: response.data.cmd,
        hash: response.data.hash,
      }
    } catch (err) {
      if (err instanceof RunnerApiError && err.statusCode === 422) {
        throw new RuntimeArtifactStateError(err.message)
      }
      throw err
    }
  }

  async inspectArtifactInRegistry(artifactRef: string, registry?: DockerRegistry): Promise<ArtifactDigestResponse> {
    const request: InspectArtifactInRegistryRequest = {
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

    const response = await this.artifactApiClient.inspectArtifactInRegistry(request)

    return {
      hash: response.data.hash,
      sizeGB: response.data.sizeGB,
    }
  }

  async updateNetworkSettings(
    sandboxId: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    networkLimitEgress?: boolean,
  ): Promise<void> {
    const updateNetworkSettingsDto: UpdateNetworkSettingsDTO = {
      networkBlockAll: networkBlockAll,
      networkAllowList: networkAllowList,
      networkLimitEgress: networkLimitEgress,
    }

    await this.sandboxApiClient.updateNetworkSettings(sandboxId, updateNetworkSettingsDto)
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
    await this.sandboxApiClient.recover(sandbox.id, recoverSandboxDTO)
  }

  async resizeSandbox(sandboxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.sandboxApiClient.resize(sandboxId, { cpu, memory, disk })
  }
}

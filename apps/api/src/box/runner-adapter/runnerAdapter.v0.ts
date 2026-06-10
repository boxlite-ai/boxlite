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
  RunnerBoxInfo,
  RunnerSnapshotInfo,
  StartBoxResponse,
  SnapshotDigestResponse,
} from './runnerAdapter'
import { SnapshotStateError } from '../errors/snapshot-state-error'
import { Runner } from '../entities/runner.entity'
import {
  Configuration,
  BoxApi,
  EnumsBoxState,
  SnapshotsApi,
  EnumsBackupState,
  DefaultApi,
  CreateBoxDTO,
  BuildSnapshotRequestDTO,
  CreateBackupDTO,
  PullSnapshotRequestDTO,
  UpdateNetworkSettingsDTO,
  RecoverBoxDTO,
} from '@boxlite-ai/runner-api-client'
import { Box } from '../entities/box.entity'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { BoxState } from '../enums/box-state.enum'
import { BackupState } from '../enums/backup-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'

const isDebugEnabled = process.env.DEBUG === 'true'

// Network error codes that should trigger a retry
const RETRYABLE_NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT']

@Injectable()
export class RunnerAdapterV0 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV0.name)
  private boxApiClient: BoxApi
  private snapshotApiClient: SnapshotsApi
  private runnerApiClient: DefaultApi

  private convertBoxState(state: EnumsBoxState): BoxState {
    switch (state) {
      case EnumsBoxState.BoxStateCreating:
        return BoxState.CREATING
      case EnumsBoxState.BoxStateRestoring:
        return BoxState.RESTORING
      case EnumsBoxState.BoxStateDestroyed:
        return BoxState.DESTROYED
      case EnumsBoxState.BoxStateDestroying:
        return BoxState.DESTROYING
      case EnumsBoxState.BoxStateStarted:
        return BoxState.STARTED
      case EnumsBoxState.BoxStateStopped:
        return BoxState.STOPPED
      case EnumsBoxState.BoxStateStarting:
        return BoxState.STARTING
      case EnumsBoxState.BoxStateStopping:
        return BoxState.STOPPING
      case EnumsBoxState.BoxStateError:
        return BoxState.ERROR
      case EnumsBoxState.BoxStatePullingSnapshot:
        return BoxState.PULLING_SNAPSHOT
      default:
        return BoxState.UNKNOWN
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

    this.boxApiClient = new BoxApi(new Configuration(), '', axiosInstance)
    this.snapshotApiClient = new SnapshotsApi(new Configuration(), '', axiosInstance)
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

  async boxInfo(boxId: string): Promise<RunnerBoxInfo> {
    const boxInfo = await this.boxApiClient.info(boxId)
    return {
      state: this.convertBoxState(boxInfo.data.state),
      backupState: this.convertBackupState(boxInfo.data.backupState),
      backupSnapshot: boxInfo.data.backupSnapshot,
      backupErrorReason: boxInfo.data.backupError,
      daemonVersion: boxInfo.data.daemonVersion,
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
    const createBoxDto: CreateBoxDTO = {
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
      otelEndpoint,
      skipStart: skipStart,
      organizationId: box.organizationId,
      regionId: box.region,
    }

    const response = await this.boxApiClient.create(createBoxDto)

    if (!response?.data?.daemonVersion) {
      return undefined
    }

    return {
      daemonVersion: response.data.daemonVersion,
    }
  }

  async startBox(
    boxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartBoxResponse | undefined> {
    const response = await this.boxApiClient.start(boxId, authToken, metadata)

    if (!response?.data?.daemonVersion) {
      return undefined
    }

    return {
      daemonVersion: response.data.daemonVersion,
    }
  }

  async stopBox(boxId: string, force?: boolean): Promise<void> {
    await this.boxApiClient.stop(boxId, { force })
  }

  async destroyBox(boxId: string): Promise<void> {
    await this.boxApiClient.destroy(boxId)
  }

  async createBackup(box: Box, backupSnapshotName: string, registry?: DockerRegistry): Promise<void> {
    const request: CreateBackupDTO = {
      snapshot: backupSnapshotName,
      registry: undefined,
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.boxApiClient.createBackup(box.id, request)
  }

  async buildSnapshot(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void> {
    const request: BuildSnapshotRequestDTO = {
      snapshot: buildInfo.snapshotRef,
      dockerfile: buildInfo.dockerfileContent,
      organizationId: organizationId,
      context: buildInfo.contextHashes,
      pushToInternalRegistry: pushToInternalRegistry,
    }

    if (sourceRegistries) {
      request.sourceRegistries = sourceRegistries.map((sourceRegistry) => ({
        project: sourceRegistry.project,
        url: sourceRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: sourceRegistry.username,
        password: sourceRegistry.password,
      }))
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.snapshotApiClient.buildSnapshot(request)
  }

  async removeSnapshot(snapshotName: string): Promise<void> {
    await this.snapshotApiClient.removeSnapshot(snapshotName)
  }

  async pullSnapshot(
    snapshotName: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
  ): Promise<void> {
    const request: PullSnapshotRequestDTO = {
      snapshot: snapshotName,
      newTag,
    }

    if (registry) {
      request.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    if (destinationRegistry) {
      request.destinationRegistry = {
        project: destinationRegistry.project,
        url: destinationRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: destinationRegistry.username,
        password: destinationRegistry.password,
      }
    }

    if (destinationRef) {
      request.destinationRef = destinationRef
    }

    await this.snapshotApiClient.pullSnapshot(request)
  }

  async snapshotExists(snapshotName: string): Promise<boolean> {
    const response = await this.snapshotApiClient.snapshotExists(snapshotName)
    return response.data.exists
  }

  async getSnapshotInfo(snapshotName: string): Promise<RunnerSnapshotInfo> {
    try {
      const response = await this.snapshotApiClient.getSnapshotInfo(snapshotName)

      return {
        name: response.data.name || '',
        sizeGB: response.data.sizeGB,
        entrypoint: response.data.entrypoint,
        cmd: response.data.cmd,
        hash: response.data.hash,
      }
    } catch (err) {
      if (err instanceof RunnerApiError && err.statusCode === 422) {
        throw new SnapshotStateError(err.message)
      }
      throw err
    }
  }

  async inspectSnapshotInRegistry(snapshotName: string, registry?: DockerRegistry): Promise<SnapshotDigestResponse> {
    const response = await this.snapshotApiClient.inspectSnapshotInRegistry({
      snapshot: snapshotName,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    })

    return {
      hash: response.data.hash,
      sizeGB: response.data.sizeGB,
    }
  }

  async updateNetworkSettings(
    boxId: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    networkLimitEgress?: boolean,
  ): Promise<void> {
    const updateNetworkSettingsDto: UpdateNetworkSettingsDTO = {
      networkBlockAll: networkBlockAll,
      networkAllowList: networkAllowList,
      networkLimitEgress: networkLimitEgress,
    }

    await this.boxApiClient.updateNetworkSettings(boxId, updateNetworkSettingsDto)
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
    await this.boxApiClient.recover(box.id, recoverBoxDTO)
  }

  async resizeBox(boxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.boxApiClient.resize(boxId, { cpu, memory, disk })
  }
}

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
  StartBoxResponse,
  ArtifactDigestResponse,
} from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import {
  Configuration,
  BoxApi,
  EnumsBoxState,
  ArtifactsApi,
  DefaultApi,
  CreateBoxDTO,
  UpdateNetworkSettingsDTO,
  InspectArtifactInRegistryRequest,
  RecoverBoxDTO,
} from '@boxlite-ai/runner-api-client'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'

const isDebugEnabled = process.env.DEBUG === 'true'

// Network error codes that should trigger a retry
const RETRYABLE_NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT']

@Injectable()
export class RunnerAdapterV0 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV0.name)
  private boxApiClient: BoxApi
  private artifactApiClient: ArtifactsApi
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
      case EnumsBoxState.BoxStatePullingArtifact:
        return BoxState.PULLING_ARTIFACT
      default:
        return BoxState.UNKNOWN
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

  async boxInfo(boxId: string): Promise<RunnerBoxInfo> {
    const boxInfo = await this.boxApiClient.info(boxId)
    return {
      state: this.convertBoxState(boxInfo.data.state),
      daemonVersion: boxInfo.data.daemonVersion,
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
    const createBoxDto: CreateBoxDTO = {
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

  async removeArtifact(artifactRef: string): Promise<void> {
    await this.artifactApiClient.removeArtifact(artifactRef)
  }

  // TODO(image-rewrite): pullArtifact removed with runner_artifact_cache + box_template.

  async artifactExists(artifactRef: string): Promise<boolean> {
    const response = await this.artifactApiClient.artifactExists(artifactRef)
    return response.data.exists
  }

  // TODO(image-rewrite): getArtifactInfo removed with runner_artifact_cache + box_template.

  async inspectArtifactInRegistry(artifactRef: string): Promise<ArtifactDigestResponse> {
    const request: InspectArtifactInRegistryRequest = {
      artifactRef,
    }

    const response = await this.artifactApiClient.inspectArtifactInRegistry(request)

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
    await this.boxApiClient.recover(box.id, recoverBoxDTO)
  }

  async resizeBox(boxId: string, cpu?: number, memory?: number, disk?: number): Promise<void> {
    await this.boxApiClient.resize(boxId, { cpu, memory, disk })
  }
}

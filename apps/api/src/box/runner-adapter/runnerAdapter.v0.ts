/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { AxiosError } from 'axios'
import axiosDebug from 'axios-debug-log'
import axiosRetry from 'axios-retry'

import { Injectable, Logger } from '@nestjs/common'
import { RunnerAdapter, RunnerInfo, RunnerBoxInfo, StartBoxResponse } from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import {
  Configuration,
  BoxApi,
  EnumsBoxState,
  DefaultApi,
  UpdateNetworkSettingsDTO,
  RecoverBoxDTO,
} from '@boxlite-ai/runner-api-client'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'

const isDebugEnabled = process.env.DEBUG === 'true'

// Network error codes that should trigger a retry
const RETRYABLE_NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT']
const RUNNER_NON_JSON_ERROR_CODE = 'runner_non_json_error'
const NON_JSON_SNIPPET_MAX_LENGTH = 180

function statusCodeFrom(error: AxiosError): number | undefined {
  return error.response?.status || (error as any).status
}

function codeFrom(error: AxiosError, data: unknown): string {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const responseCode = (data as Record<string, unknown>).code
    if (typeof responseCode === 'string' && responseCode) {
      return responseCode
    }
  }

  return (error as any).code || (error as any).cause?.code || 'RUNNER_API_ERROR'
}

function messageFromJson(data: Record<string, unknown>, fallback: string): string {
  const responseMessage = data.message
  if (Array.isArray(responseMessage)) {
    return responseMessage.join(', ')
  }
  if (typeof responseMessage === 'string' && responseMessage) {
    return responseMessage
  }
  if (typeof data.error === 'string' && data.error) {
    return data.error
  }
  return fallback
}

function visibleTextFromMarkup(input: string): string {
  let output = ''
  let index = 0
  let skipping: 'script' | 'style' | null = null

  while (index < input.length) {
    const char = input[index]
    if (char !== '<') {
      if (!skipping) {
        output += char
      }
      index += 1
      continue
    }

    const closeIndex = input.indexOf('>', index + 1)
    if (closeIndex === -1) {
      if (!skipping) {
        output += input.slice(index)
      }
      break
    }

    const tagBody = input
      .slice(index + 1, closeIndex)
      .trim()
      .toLowerCase()
    const tagName = tagBody.replace(/^\//, '').split(/\s+/)[0]
    if (!tagBody.startsWith('/') && (tagName === 'script' || tagName === 'style')) {
      skipping = tagName
    } else if (skipping && tagBody.startsWith('/') && tagName === skipping) {
      skipping = null
    } else if (!skipping) {
      output += ' '
    }

    index = closeIndex + 1
  }

  return output
}

export function sanitizedNonJsonRunnerMessage(data: unknown): string {
  const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : JSON.stringify(data)
  const text = visibleTextFromMarkup(raw)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b(access_token|id_token|api_key|token)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) {
    return 'Runner API returned a non-JSON error response'
  }

  const suffix = text.length > NON_JSON_SNIPPET_MAX_LENGTH ? '...' : ''
  return `Runner API returned a non-JSON error response: ${text.slice(0, NON_JSON_SNIPPET_MAX_LENGTH)}${suffix}`
}

@Injectable()
export class RunnerAdapterV0 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV0.name)
  private boxApiClient: BoxApi
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
        const data = error.response?.data
        const statusCode =
          data && typeof data === 'object' && !Array.isArray(data) && typeof data.statusCode === 'number'
            ? data.statusCode
            : statusCodeFrom(error)

        if (data && typeof data === 'object' && !Array.isArray(data) && !Buffer.isBuffer(data)) {
          throw new RunnerApiError(
            messageFromJson(data as Record<string, unknown>, error.message),
            statusCode,
            codeFrom(error, data),
          )
        }

        if (data !== undefined && data !== null && data !== '') {
          const sanitizedMessage = sanitizedNonJsonRunnerMessage(data)
          this.logger.warn(`Runner API returned non-JSON error (${statusCode || 'no status'}): ${sanitizedMessage}`)
          throw new RunnerApiError(sanitizedMessage, statusCode, RUNNER_NON_JSON_ERROR_CODE)
        }

        throw new RunnerApiError(error.message || 'Runner API request failed', statusCode, codeFrom(error, data))
      },
    )

    if (isDebugEnabled) {
      axiosDebug.addLogger(axiosInstance)
    }

    this.boxApiClient = new BoxApi(new Configuration(), '', axiosInstance)
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

  async createBox(box: Box, metadata?: { [key: string]: string }): Promise<StartBoxResponse | undefined> {
    const response = await this.boxApiClient.create({
      id: box.id,
      image: box.image ?? '',
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
      metadata,
      authToken: box.authToken,
      organizationId: box.organizationId,
      regionId: box.region,
    })

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

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { AxiosError, AxiosInstance } from 'axios'
import axiosDebug from 'axios-debug-log'
import axiosRetry from 'axios-retry'
import { createHmac, randomBytes } from 'node:crypto'
import { Agent } from 'node:https'

import { Injectable, Logger, Optional } from '@nestjs/common'
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
import { memoryGiBOf } from '../utils/memory-allocation'
import { BoxState } from '../enums/box-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'
import { ProtectedBootstrapService } from '../services/protected-bootstrap.service'
import { OutboundCommitUnknown } from '../stores/outbound-policy.store'
import { checkedBootReceipt, ProtectedBootKey, ProtectedBootRoute } from './protected-runner'

const isDebugEnabled = process.env.DEBUG === 'true'

// Network error codes that should trigger a retry
const RETRYABLE_NETWORK_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT']
const RUNNER_NON_JSON_ERROR_CODE = 'runner_non_json_error'
const NON_JSON_SNIPPET_MAX_LENGTH = 180

function protectedCommand(payload: unknown) {
  const body = JSON.stringify(payload)
  const requestKey = randomBytes(32)
  const fingerprint = createHmac('sha256', requestKey).update(body).digest('hex')
  return { body, fingerprint, headers: { 'X-BoxLite-Bootstrap-Key': requestKey.toString('base64url') } }
}

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
  private runner: Runner
  private bootstrapApi?: AxiosInstance

  constructor(@Optional() private readonly protectedBootstrap?: ProtectedBootstrapService) {}

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
    this.runner = runner

    const endpoint = URL.parse(runner.apiUrl)
    const headers = { Authorization: `Bearer ${runner.apiKey}` }
    this.bootstrapApi =
      endpoint?.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        ? axios.create({
            baseURL: endpoint.href,
            headers: { ...headers, 'X-BoxLite-Runner-Id': runner.id },
            httpsAgent: new Agent({ rejectUnauthorized: true }),
            maxRedirects: 0,
            proxy: false,
            timeout: 120_000,
          })
        : undefined

    const axiosInstance = axios.create({
      baseURL: runner.apiUrl,
      headers,
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

  async supportsProtectedBootstrap(): Promise<boolean> {
    if (!this.bootstrapApi) return false
    try {
      const { data } = await this.bootstrapApi.get('/v1/outbound-proxy/bootstrap', { timeout: 3000 })
      return (
        data.runner_id === this.runner.id &&
        data.version === 1 &&
        Array.isArray(data.operations) &&
        ['prepare', 'start', 'receipt', 'retire'].every((operation) => data.operations.includes(operation))
      )
    } catch {
      return false
    }
  }

  async createProtectedBox(
    box: Box,
    image: string,
    key: ProtectedBootKey,
    loadRoute: () => Promise<ProtectedBootRoute>,
  ) {
    const bootstrap = this.protectedBootstrap
    if (
      !bootstrap ||
      box.runnerId !== this.runner.id ||
      key.runner_id !== this.runner.id ||
      !(await this.supportsProtectedBootstrap())
    ) {
      throw new Error('Runner does not qualify for protected bootstrap')
    }
    const route = await loadRoute()
    const prepare = protectedCommand({
      key,
      configuration: { ...this.createParameters(box, image, undefined, false, true), volumes: box.volumes },
    })
    const start = protectedCommand({ ...route, key })
    const reserve = () => bootstrap.reserve(box, key, prepare.fingerprint, start.fingerprint)
    try {
      await reserve()
    } catch (error) {
      if (!(error instanceof OutboundCommitUnknown)) throw error
      try {
        await reserve()
      } catch (recoveryError) {
        await this.retireProtectedBoot(box.id, key, undefined, true).catch(() => undefined)
        throw recoveryError
      }
    }
    try {
      const prepared = (await this.sendProtectedCommand(box.id, '/prepare', key, prepare.body, prepare.headers)) as {
        box_id?: string
        native_id?: string
      }
      if (prepared?.box_id !== box.id || typeof prepared.native_id !== 'string' || !prepared.native_id) {
        throw new Error('Runner did not confirm the prepared native Box')
      }
      await bootstrap.prepared(box.id, key, prepared.native_id)
      const evidence = await this.sendProtectedCommand(box.id, '', key, start.body, start.headers)
      const receipt = checkedBootReceipt(evidence, box.id, key)
      if (receipt.outcome !== 'confirmed') throw new Error('Runner did not confirm protected startup')
      await bootstrap.settle(box.id, key, evidence)
      return receipt
    } catch (error) {
      let failure = error
      const receipt = await this.readProtectedBoot(box.id, key).catch(() => undefined)
      if (receipt?.outcome === 'confirmed') {
        try {
          await bootstrap.settle(box.id, key, { box_id: box.id, receipt })
          return receipt
        } catch (settlementError) {
          failure = settlementError
        }
      }
      await this.retireProtectedBoot(box.id, key, undefined, true).catch(() => undefined)
      throw failure
    }
  }

  async readProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string) {
    return checkedBootReceipt(await this.sendProtectedCommand(boxId, '/receipt', key, key), boxId, key, expectedEpoch)
  }

  async retireProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string, onlyUnsettled = false) {
    if (!this.protectedBootstrap) throw new Error('Protected bootstrap settlement is unavailable')
    const epoch = await this.protectedBootstrap.beginRetirement(boxId, key, expectedEpoch, onlyUnsettled)
    const evidence = await this.sendProtectedCommand(boxId, '/retire', key, key)
    const receipt = checkedBootReceipt(evidence, boxId, key, epoch)
    if (receipt.outcome !== 'retired') throw new Error('Runner did not confirm protected retirement')
    await this.protectedBootstrap.settle(boxId, key, evidence)
    return receipt
  }

  private async sendProtectedCommand(
    boxId: string,
    suffix: '' | '/prepare' | '/receipt' | '/retire',
    key: ProtectedBootKey,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    if (!this.bootstrapApi || key.runner_id !== this.runner.id)
      throw new Error('Protected bootstrap requires the assigned Runner HTTPS endpoint')
    try {
      const path = `/v1/boxes/${encodeURIComponent(boxId)}/network/outbound/bootstrap${suffix}`
      return (await this.bootstrapApi.post(path, body, { headers: { 'Content-Type': 'application/json', ...headers } }))
        .data
    } catch {
      // Axios errors retain the request body, including the proxy credential.
      throw new Error('Protected Runner bootstrap outcome is unconfirmed')
    }
  }

  async runnerInfo(signal?: AbortSignal): Promise<RunnerInfo> {
    const response = await this.runnerApiClient.runnerInfo({ signal })
    return {
      serviceHealth: response.data.serviceHealth,
      metrics: response.data.metrics,
      appVersion: response.data.appVersion,
      supportsPrivileged: response.data.supportsPrivileged,
      nestedVirtualizationEnabled: response.data.nestedVirtualizationEnabled,
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
    image: string,
    metadata?: { [key: string]: string },
    nestedVirtualization = false,
  ): Promise<StartBoxResponse | undefined> {
    const response = await this.boxApiClient.create(this.createParameters(box, image, metadata, nestedVirtualization))
    if (!response?.data?.daemonVersion) return undefined
    return { daemonVersion: response.data.daemonVersion }
  }

  private createParameters(
    box: Box,
    image: string,
    metadata?: Record<string, string>,
    nestedVirtualization = false,
    protectedPlaceholder = false,
  ): Parameters<BoxApi['create']>[0] {
    if (box.privileged && !this.runner.supportsPrivileged) {
      throw new Error(`Runner ${this.runner.id} does not support privileged Boxes`)
    }
    return {
      id: box.id,
      ...(nestedVirtualization ? { nestedVirtualization: true } : {}),
      image,
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: memoryGiBOf(box),
      storageQuota: box.disk,
      env: box.env,
      runAsUser: box.runAsUser,
      privileged: box.privileged,
      workingDir: box.workingDir,
      entrypoint: box.entrypoint,
      cmd: box.cmd,
      secrets: box.secrets?.map((secret) => ({
        name: secret.name,
        value: secret.value,
        hosts: secret.hosts,
        placeholder: secret.placeholder,
        headers: secret.headers,
      })),
      ...(protectedPlaceholder
        ? { outboundEnabled: false, skipStart: true }
        : { outboundEnabled: box.outboundEnabled, outboundAllowNet: box.outboundAllowNet ?? undefined }),
      metadata,
      authToken: box.authToken,
      organizationId: box.organizationId,
      regionId: box.region,
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
    outboundEnabled?: boolean,
    outboundAllowNet?: string[],
    networkLimitEgress?: boolean,
  ): Promise<void> {
    const updateNetworkSettingsDto: UpdateNetworkSettingsDTO = {
      outboundEnabled,
      outboundAllowNet,
      networkLimitEgress,
    }

    await this.boxApiClient.updateNetworkSettings(boxId, updateNetworkSettingsDto)
  }

  async recoverBox(box: Box): Promise<void> {
    if (box.privileged && !this.runner.supportsPrivileged) {
      throw new Error(`Runner ${this.runner.id} does not support privileged Boxes`)
    }
    const recoverBoxDTO: RecoverBoxDTO = {
      osUser: box.osUser,
      cpuQuota: box.cpu,
      gpuQuota: box.gpu,
      memoryQuota: memoryGiBOf(box),
      storageQuota: box.disk,
      env: box.env,
      privileged: box.privileged,
      secrets: box.secrets?.map((secret) => ({
        name: secret.name,
        value: secret.value,
        hosts: secret.hosts,
        placeholder: secret.placeholder,
        headers: secret.headers,
      })),
      volumes: box.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      outboundEnabled: box.outboundEnabled,
      outboundAllowNet: box.outboundAllowNet ?? undefined,
      errorReason: box.errorReason,
    }
    await this.boxApiClient.recover(box.id, recoverBoxDTO)
  }
}

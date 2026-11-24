/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import axios, { AxiosError, AxiosInstance } from 'axios'
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
import type { BoxVolume } from '../dto/box.dto'
import { memoryGiBOf } from '../utils/memory-allocation'
import { BoxState } from '../enums/box-state.enum'
import { RunnerApiError } from '../errors/runner-api-error'
import {
  checkedBootReceipt,
  enrolledRunnerAgent,
  ProtectedBootCapability,
  ProtectedBootControl,
  ProtectedBootKey,
  ProtectedBootRoute,
} from './protected-runner'
import {
  checkedManagedReceipt,
  checkedManagedSnapshot,
  checkedSealedEvidence,
  ManagedCommand,
  ManagedReceipt,
  ManagedSnapshot,
  sameManagedSnapshot,
} from './protected-outbound'

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
  private runner: Runner
  private bootstrapApi?: AxiosInstance

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

    const httpsAgent = enrolledRunnerAgent(runner)
    const enrolledTransport = httpsAgent && { httpsAgent, maxRedirects: 0, proxy: false as const }
    const headers = { Authorization: `Bearer ${runner.apiKey}` }
    this.bootstrapApi = enrolledTransport
      ? axios.create({
          ...enrolledTransport,
          baseURL: runner.apiUrl,
          headers: { ...headers, 'X-BoxLite-Runner-Id': runner.id },
          timeout: 120_000,
        })
      : undefined

    const axiosInstance = axios.create({
      baseURL: runner.apiUrl,
      headers,
      ...enrolledTransport,
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

  async supportsProtectedBootstrap(recovery = false, volumeRestart = false): Promise<boolean> {
    return (await this.protectedBootstrapCapability(recovery, volumeRestart)) === 'supported'
  }

  async protectedBootstrapCapability(recovery = false, volumeRestart = false): Promise<ProtectedBootCapability> {
    if (!this.bootstrapApi) return 'unverified'
    try {
      const { data } = await this.bootstrapApi.get('/v1/outbound-proxy/bootstrap', { timeout: 3000 })
      const required = recovery
        ? [
            'start',
            'receipt',
            'retire',
            'release-gate',
            'seal-gate',
            'managed-route',
            'unbound-start',
            'remove-retired',
          ]
        : ['start', 'receipt', 'retire']
      if (volumeRestart) required.push('restart-volumes')
      if (
        data.runner_id !== this.runner.id ||
        data.version !== 1 ||
        !Array.isArray(data.operations) ||
        !data.operations.every((operation: unknown) => typeof operation === 'string')
      ) {
        return 'unverified'
      }
      return required.every((operation) => data.operations.includes(operation)) ? 'supported' : 'unsupported'
    } catch {
      return 'unverified'
    }
  }

  get protectedBootstrap(): ProtectedBootControl | undefined {
    return this.bootstrapApi ? this : undefined
  }

  async prepareProtectedBox(box: Box, image: string, metadata: Record<string, string>, nestedVirtualization: boolean) {
    if (!this.bootstrapApi || box.runnerId !== this.runner.id) throw new Error('Protected Runner enrollment is missing')
    return this.createBox(box, image, metadata, nestedVirtualization, true)
  }

  async startProtectedBox(
    boxId: string,
    key: ProtectedBootKey,
    route: ProtectedBootRoute | null,
    generation?: string,
    restart?: boolean,
    restartVolumes?: BoxVolume[],
  ) {
    return this.protectedBootOperation(boxId, '', key, {
      ...route,
      key,
      recovery_generation: generation,
      restart,
      restart_volumes: restartVolumes,
    })
  }

  async createProtectedBox(
    box: Box,
    image: string,
    key: ProtectedBootKey,
    loadRoute: () => Promise<ProtectedBootRoute>,
    recoveryGeneration?: string,
  ) {
    if (
      box.runnerId !== this.runner.id ||
      key.runner_id !== this.runner.id ||
      !(await this.supportsProtectedBootstrap(recoveryGeneration !== undefined))
    ) {
      throw new Error('Runner does not qualify for protected bootstrap')
    }
    await this.prepareProtectedBox(box, image, {}, false)
    return this.startProtectedBox(box.id, key, await loadRoute(), recoveryGeneration)
  }

  async readProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string) {
    return this.protectedBootOperation(boxId, '/receipt', key, key, expectedEpoch)
  }

  async retireProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string) {
    return this.protectedBootOperation(boxId, '/retire', key, key, expectedEpoch)
  }

  async removeRetiredEpoch(boxId: string, key: ProtectedBootKey, epoch: string | null) {
    const evidence = await this.postProtectedOutbound(boxId, '/bootstrap/remove-retired', key.runner_id, { key, epoch })
    const receipt = checkedBootReceipt(evidence, boxId, key, epoch)
    if (receipt.outcome !== 'retired') throw new Error('Protected Runner removal is unconfirmed')
    return receipt
  }

  async managedOutbound(boxId: string, epoch: string, command: ManagedCommand): Promise<ManagedReceipt> {
    const evidence = await this.postProtectedOutbound(boxId, '/managed-route', this.runner.id, {
      runner_id: this.runner.id,
      epoch,
      command,
    })
    return checkedManagedReceipt(evidence, boxId, this.runner.id, epoch)
  }

  async changeProtectedBootGate(
    boxId: string,
    key: ProtectedBootKey,
    epoch: string,
    generation: string,
    action: 'release' | 'seal',
    outbound?: ManagedSnapshot,
  ): Promise<void> {
    await this.readGateChange(boxId, key, epoch, generation, action, outbound)
  }

  async sealProtectedEpoch(boxId: string, key: ProtectedBootKey, epoch: string, generation: string) {
    const receipt = await this.readGateChange(boxId, key, epoch, generation, 'seal')
    return checkedSealedEvidence(receipt.evidence, epoch)
  }

  private async readGateChange(
    boxId: string,
    key: ProtectedBootKey,
    epoch: string,
    generation: string,
    action: 'release' | 'seal',
    outbound?: ManagedSnapshot,
  ) {
    const evidence = await this.postProtectedOutbound(boxId, `/bootstrap/${action}-gate`, key.runner_id, {
      key,
      epoch,
      generation,
      outbound,
    })
    const response = evidence as {
      box_id?: unknown
      receipt?: {
        boot?: unknown
        generation?: unknown
        closed?: unknown
        sealed?: unknown
        outbound?: unknown
        evidence?: unknown
      }
    } | null
    const receipt = response?.receipt
    const boot = checkedBootReceipt({ box_id: response?.box_id, receipt: receipt?.boot }, boxId, key, epoch)
    const sealing = action === 'seal'
    if (
      boot.outcome !== 'confirmed' ||
      receipt?.generation !== generation ||
      receipt.closed !== sealing ||
      receipt.sealed !== sealing ||
      (outbound && !sameManagedSnapshot(checkedManagedSnapshot(receipt.outbound, epoch), outbound))
    ) {
      throw new Error('Runner did not confirm the exact protected recovery gate change')
    }
    return receipt
  }

  private async protectedBootOperation(
    boxId: string,
    suffix: '' | '/receipt' | '/retire',
    key: ProtectedBootKey,
    body: unknown,
    expectedEpoch?: string,
  ) {
    const evidence = await this.postProtectedOutbound(boxId, `/bootstrap${suffix}`, key.runner_id, body)
    const receipt = checkedBootReceipt(evidence, boxId, key, expectedEpoch)
    if ((!suffix && receipt.outcome !== 'confirmed') || (suffix === '/retire' && receipt.outcome !== 'retired')) {
      throw new Error('Unexpected protected bootstrap outcome')
    }
    return receipt
  }

  private async postProtectedOutbound(
    boxId: string,
    suffix:
      | '/bootstrap'
      | '/bootstrap/receipt'
      | '/bootstrap/retire'
      | '/bootstrap/release-gate'
      | '/bootstrap/seal-gate'
      | '/bootstrap/remove-retired'
      | '/managed-route',
    runnerId: string,
    body: unknown,
  ): Promise<unknown> {
    if (!this.bootstrapApi || runnerId !== this.runner.id) throw new Error('Protected Runner enrollment is missing')
    try {
      const path = `/v1/boxes/${encodeURIComponent(boxId)}/network/outbound${suffix}`
      return (await this.bootstrapApi.post(path, body, suffix === '/bootstrap' ? undefined : { timeout: 10_000 })).data
    } catch {
      // Axios errors retain the request body, including the proxy credential.
      throw new Error('Protected Runner outbound outcome is unconfirmed')
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
    protectedPlaceholder = false,
  ): Promise<StartBoxResponse | undefined> {
    if (box.privileged && !this.runner.supportsPrivileged) {
      throw new Error(`Runner ${this.runner.id} does not support privileged Boxes`)
    }
    const response = await this.boxApiClient.create({
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

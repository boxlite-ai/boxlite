/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, Injectable, Logger } from '@nestjs/common'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import type { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'

export const RUNNER_JSON_LIMIT = 128 * 1024
export const RUNNER_ARCHIVE_LIMIT = 64 * 1024
const NETWORK_TIMEOUT_MS = 30_000

export interface RunnerExecInput {
  command: string
  args?: string[]
  env?: Record<string, string>
  timeout_seconds?: number
  working_dir?: string
  tty?: boolean
}

export type RunnerOperation =
  | { kind: 'exec'; input: RunnerExecInput }
  | { kind: 'status' | 'kill'; executionId: string }
  | { kind: 'signal'; executionId: string; signal: 1 | 2 | 3 | 6 | 10 | 12 | 15 | 28 }
  | { kind: 'resize'; executionId: string; cols: number; rows: number }
  | { kind: 'upload'; path: string; archive: Buffer; sourceIsDirectory?: boolean }
  | { kind: 'download'; path: string }
  | { kind: 'metrics' }

export interface RunnerReply {
  body: Buffer
  sourceIsDirectory?: boolean
}

/** Only this error's message is suitable for returning through MCP. */
export class RunnerHttpError extends Error {}

/** Credentialed, organization-scoped HTTP boundary; callers cannot choose URLs or headers. */
@Injectable()
export class McpRunnerHttp {
  private readonly logger = new Logger(McpRunnerHttp.name)

  constructor(
    private readonly boxes: BoxService,
    private readonly runners: RunnerService,
    private readonly autoResume: BoxAutoResumeService,
  ) {}

  async execute(
    auth: OrganizationAuthContext,
    boxId: string,
    operation: RunnerOperation,
    signal?: AbortSignal,
  ): Promise<RunnerReply> {
    const request = runnerRequest(operation)
    let stopHeartbeat = (): void => undefined
    let dispatched = false
    let knownFailure = false
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      if (signal?.aborted) controller.abort()
      requireActive(controller.signal)
      if (!auth.organizationId || auth.organization?.id !== auth.organizationId) {
        throw new RunnerHttpError('Organization not found or not accessible')
      }
      if (!boxId || boxId.length > 256 || boxId.includes('\0')) {
        throw new RunnerHttpError('Invalid Box reference')
      }
      const box = await this.boxes.findOneByIdOrName(boxId, auth.organizationId).catch((error: unknown) => {
        if (error instanceof HttpException && error.getStatus() === 404) {
          throw new RunnerHttpError('Box not found or not accessible')
        }
        throw error
      })
      if (!box || box.organizationId !== auth.organizationId) {
        throw new RunnerHttpError('Box not found or not accessible')
      }
      const runnerBoxId = routeSegment(box.id)
      requireActive(controller.signal)
      if (operation.kind !== 'metrics') {
        await this.recordActivity(box.id)
        requireActive(controller.signal)
        if (box.autoStop > 0) {
          const heartbeat = setInterval(() => void this.recordActivity(box.id), box.autoStop * 500)
          heartbeat.unref?.()
          stopHeartbeat = () => clearInterval(heartbeat)
        }
        if (box.autoResume) {
          // Cancellation stops waiting, but cannot revoke an already submitted resume.
          await waitUntilReady(this.autoResume.ensureReady(box.id, auth.organization), controller.signal)
        }
      }
      requireActive(controller.signal)
      const runner = await this.runners.findOne(box.runnerId)
      if (!runner?.apiKey || !(runner.apiUrl || runner.proxyUrl)) {
        throw new RunnerHttpError('Runner endpoint unavailable')
      }
      const url = new URL(runner.apiUrl || runner.proxyUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new RunnerHttpError('Runner endpoint unavailable')
      }
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/boxes/${runnerBoxId}${request.path}`
      url.search = request.query?.toString() ?? ''
      url.hash = ''
      requireActive(controller.signal)
      timeout = setTimeout(cancel, NETWORK_TIMEOUT_MS)
      dispatched = true
      const response = await fetch(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${runner.apiKey}`,
          Accept: operation.kind === 'download' ? 'application/x-tar' : 'application/json',
          ...(request.body
            ? { 'Content-Type': operation.kind === 'upload' ? 'application/x-tar' : 'application/json' }
            : {}),
        },
        body: request.body as BodyInit | undefined,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        knownFailure = true
        await response.body?.cancel()
        throw new RunnerHttpError(`Runner ${operation.kind} failed (HTTP ${response.status})`)
      }
      const body = await readBounded(response, operation.kind === 'download' ? RUNNER_ARCHIVE_LIMIT : RUNNER_JSON_LIMIT)
      const hint = response.headers.get('x-boxlite-source-is-dir')
      return { body, ...(hint === 'true' || hint === 'false' ? { sourceIsDirectory: hint === 'true' } : {}) }
    } catch (error) {
      const uncertain = dispatched && request.method !== 'GET'
      if (error instanceof RunnerHttpError) {
        if (uncertain && !knownFailure) {
          throw new RunnerHttpError(`${error.message}. The operation may have started. Its outcome is unknown.`)
        }
        throw error
      }
      throw new RunnerHttpError(
        uncertain
          ? `Runner ${operation.kind} interrupted; the operation may have started. Its outcome is unknown.`
          : `Runner ${operation.kind} unavailable or interrupted`,
      )
    } finally {
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
      stopHeartbeat()
    }
  }

  private async recordActivity(boxId: string): Promise<void> {
    try {
      await this.boxes.updateLastActivityAt(boxId, new Date())
    } catch {
      this.logger.warn('MCP Runner activity update failed')
    }
  }
}

function routeSegment(value: string): string {
  if (!value || value.length > 256 || value === '.' || value === '..' || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new RunnerHttpError('Invalid Box or execution identifier')
  }
  return encodeURIComponent(value)
}

function runnerRequest(operation: RunnerOperation): {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: URLSearchParams
  body?: string | Buffer
} {
  switch (operation.kind) {
    case 'exec':
      return { method: 'POST', path: '/exec', body: boundedJson(operation.input) }
    case 'status':
    case 'kill':
      return {
        method: operation.kind === 'status' ? 'GET' : 'DELETE',
        path: `/executions/${routeSegment(operation.executionId)}`,
      }
    case 'signal':
      return {
        method: 'POST',
        path: `/executions/${routeSegment(operation.executionId)}/signal`,
        body: boundedJson({ signal: operation.signal }),
      }
    case 'resize':
      return {
        method: 'POST',
        path: `/executions/${routeSegment(operation.executionId)}/resize`,
        body: boundedJson({ cols: operation.cols, rows: operation.rows }),
      }
    case 'upload':
    case 'download': {
      if (!operation.path || operation.path.length > 4096 || operation.path.includes('\0')) {
        throw new RunnerHttpError('Invalid guest file path')
      }
      const query = new URLSearchParams({ path: operation.path })
      if (operation.kind === 'download') return { method: 'GET', path: '/files', query }
      if (operation.archive.length > RUNNER_ARCHIVE_LIMIT) throw new RunnerHttpError('Archive exceeds 64 KiB')
      if (operation.sourceIsDirectory !== undefined) query.set('source_is_dir', String(operation.sourceIsDirectory))
      return { method: 'PUT', path: '/files', query, body: operation.archive }
    }
    case 'metrics':
      return { method: 'GET', path: '/metrics' }
    default:
      throw new RunnerHttpError('Unsupported Runner operation')
  }
}

function boundedJson(input: unknown): string {
  const body = JSON.stringify(input)
  if (Buffer.byteLength(body) > RUNNER_JSON_LIMIT) throw new RunnerHttpError('Runner request exceeds 128 KiB')
  return body
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new RunnerHttpError('Runner request cancelled before dispatch')
}

async function waitUntilReady(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  requireActive(signal)
  let cancel: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new RunnerHttpError('Runner request cancelled; a resume may already have started'))
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    await Promise.race([ready, aborted])
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel)
  }
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size)
      size += value.length
      if (size > limit) throw new RunnerHttpError(`Runner response exceeds ${limit / 1024} KiB`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

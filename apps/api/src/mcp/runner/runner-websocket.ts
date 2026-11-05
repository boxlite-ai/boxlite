/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import WebSocket from 'isomorphic-ws'
import type { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { BoxService } from '../../box/services/box.service'
import { RunnerService } from '../../box/services/runner.service'
import { BoxAutoResumeService } from '../../box/services/box-auto-resume.service'
import { McpToolError } from '../errors/tool-error'

export interface ExecutionCapture {
  execution_id: string
  stdout: string
  stderr: string
  stop_reason: 'exit' | 'time_limit' | 'byte_limit'
  exit_code: number | null
  limit_reached: boolean
  history_complete: 'unknown'
}

export interface CaptureOptions {
  maxBytes: number
  waitSeconds: number
}

/** One bounded attach; the Runner owns replay, single-attach admission and orphan reaping. */
@Injectable()
export class McpRunnerWebSocket {
  private readonly logger = new Logger(McpRunnerWebSocket.name)

  constructor(
    private readonly boxes: BoxService,
    private readonly runners: RunnerService,
    private readonly autoResume: BoxAutoResumeService,
  ) {}

  async capture(
    auth: OrganizationAuthContext,
    boxReference: string,
    executionId: string,
    options: CaptureOptions,
    signal?: AbortSignal,
  ): Promise<ExecutionCapture> {
    let resumed = false
    const cancelled = () =>
      failure(
        'cancelled',
        resumed ? 'Output capture cancelled; a submitted resume may continue.' : 'Output capture cancelled',
        { source: 'mcp', outcome: resumed ? 'unknown' : undefined },
      )
    if (signal?.aborted) throw cancelled()
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled())
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const active = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, aborted])
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      if (!auth.organizationId || auth.organization?.id !== auth.organizationId) {
        throw new NotFoundException('Organization not found or not accessible')
      }
      const box = await active(this.boxes.findOneByIdOrName(boxReference, auth.organizationId))
      if (!box || box.organizationId !== auth.organizationId) {
        throw new NotFoundException('Box not found or not accessible')
      }
      const boxId = routeSegment(box.id)
      const execId = routeSegment(executionId)
      await active(this.recordActivity(box.id))
      if (box.autoStop > 0) {
        heartbeat = setInterval(() => void this.recordActivity(box.id), box.autoStop * 500)
        heartbeat.unref?.()
      }
      if (box.autoResume) {
        resumed = true
        // Cancellation ends this wait; it cannot revoke a lifecycle request already submitted.
        await active(this.autoResume.ensureReady(box.id, auth.organization))
      }
      const runner = await active(this.runners.findOne(box.runnerId))
      if (!runner?.apiKey || !(runner.apiUrl || runner.proxyUrl)) {
        throw failure('upstream_unavailable', 'Runner endpoint unavailable')
      }
      const url = attachUrl(runner.apiUrl || runner.proxyUrl, boxId, execId)
      if (signal?.aborted) throw cancelled()
      return await captureSocket(url, runner.apiKey, executionId, options, signal)
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      if (heartbeat) clearInterval(heartbeat)
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

function attachUrl(endpoint: string, boxId: string, executionId: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw failure('upstream_unavailable', 'Runner endpoint unavailable')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw failure('upstream_unavailable', 'Runner endpoint unavailable')
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/boxes/${boxId}/executions/${executionId}/attach`
  url.search = ''
  url.hash = ''
  return url
}

function routeSegment(value: string): string {
  if (!value || value.length > 256 || value === '.' || value === '..' || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw failure('invalid_argument', 'Invalid Box or execution identifier', { source: 'mcp' })
  }
  return encodeURIComponent(value)
}

function captureSocket(
  url: URL,
  apiKey: string,
  executionId: string,
  options: CaptureOptions,
  signal?: AbortSignal,
): Promise<ExecutionCapture> {
  return new Promise((resolve, reject) => {
    // The declared wrapper exports ws in Node. The pinned runtime supports closeTimeout.
    const clientOptions = {
      headers: { Authorization: `Bearer ${apiKey}` },
      followRedirects: false,
      perMessageDeflate: false,
      allowSynchronousEvents: false,
      handshakeTimeout: 5_000,
      maxPayload: 256 * 1024 + 1,
      closeTimeout: 1_000,
    }
    const socket = new WebSocket(url, clientOptions)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let deadline: ReturnType<typeof setTimeout> | undefined
    let outcome: ExecutionCapture | Error | undefined
    const result = (reason: ExecutionCapture['stop_reason'], exitCode: number | null = null): ExecutionCapture => ({
      execution_id: executionId,
      // Decode once per stream: a UTF-8 sequence may cross WebSocket message boundaries.
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stop_reason: reason,
      exit_code: exitCode,
      limit_reached: reason === 'byte_limit',
      history_complete: 'unknown',
    })
    const stop = (value: ExecutionCapture | Error): void => {
      if (outcome) return
      outcome = value
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    }
    const cancel = (): void => stop(failure('cancelled', 'Output capture cancelled', { source: 'mcp' }))
    socket.once('open', () => {
      if (!outcome) deadline = setTimeout(() => stop(result('time_limit')), options.waitSeconds * 1000)
    })
    socket.on('message', (data, binary) => {
      if (outcome) return
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      if (binary) {
        if (!frame.length || (frame[0] !== 1 && frame[0] !== 2)) {
          stop(failure('invalid_response', 'Runner sent an invalid output channel'))
          return
        }
        const accepted = Math.min(frame.length - 1, options.maxBytes - bytes)
        if (accepted) (frame[0] === 1 ? stdout : stderr).push(Buffer.from(frame.subarray(1, accepted + 1)))
        bytes += accepted
        if (bytes === options.maxBytes) stop(result('byte_limit'))
        return
      }
      let exit: unknown
      try {
        exit = JSON.parse(frame.toString('utf8'))
      } catch {
        stop(failure('invalid_response', 'Runner sent an invalid output control frame'))
        return
      }
      if (
        typeof exit !== 'object' ||
        exit === null ||
        Array.isArray(exit) ||
        Object.keys(exit).sort().join(',') !== 'exit_code,type' ||
        (exit as { type?: unknown }).type !== 'exit' ||
        !Number.isSafeInteger((exit as { exit_code?: unknown }).exit_code)
      ) {
        stop(failure('invalid_response', 'Runner sent an invalid output control frame'))
        return
      }
      stop(result('exit', (exit as { exit_code: number }).exit_code))
    })
    socket.once('unexpected-response', (request, response) => {
      const status = response.statusCode
      const code = status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'upstream_error'
      const message =
        status === 409
          ? 'Execution output is already attached or unavailable; another client may hold the connection'
          : status === 404
            ? 'Execution not found or not accessible'
            : 'Runner refused the output connection'
      stop(failure(code, message, { status }))
      // Installing this listener disables ws's default abort; never wait for an error body to end.
      response.destroy()
      request.destroy()
    })
    socket.on('error', (error: Error & { code?: string }) =>
      stop(
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? failure('resource_exhausted', 'Runner output message exceeds the 256 KiB payload limit')
          : failure('interrupted', 'Runner output connection failed or was interrupted'),
      ),
    )
    socket.once('close', () => {
      if (deadline) clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      socket.removeAllListeners()
      const final =
        outcome ?? failure('interrupted', 'Runner output connection closed without execution exit information')
      if (final instanceof Error) reject(final)
      else resolve(final)
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

function failure(
  code: string,
  message: string,
  options: { status?: number; outcome?: 'unknown'; source?: 'runner' | 'mcp' } = {},
): McpToolError {
  return new McpToolError(message, {
    source: options.source ?? 'runner',
    operation: 'get_execution_output',
    code,
    message,
    ...(options.status && options.status >= 100 && options.status <= 599 ? { status: options.status } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
  })
}

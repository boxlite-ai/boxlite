/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { McpToolError, type ToolFailure } from '../errors/tool-error'
import type { RunnerOperation } from './runner-http'

export class RunnerHttpError extends McpToolError {}

export function runnerError(operation: RunnerOperation, status: number, payload: unknown): RunnerHttpError {
  const codes: Record<number, string> = {
    400: 'invalid_argument',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'invalid_state',
    410: 'session_reaped',
    422: 'execution_failed',
    429: 'resource_exhausted',
    503: 'upstream_unavailable',
  }
  const failure: ToolFailure = {
    source: 'runner',
    operation: operation.kind,
    status,
    code: codes[status] ?? 'upstream_error',
    message: `Runner ${operation.kind} failed (HTTP ${status})`,
  }
  const envelope = record(payload) ? payload.error : undefined
  if ((operation.kind === 'upload' || operation.kind === 'download') && record(envelope)) {
    const fileCodes: Record<string, [number, string]> = {
      unsupported: [400, 'UnsupportedError'],
      not_found: [404, 'NotFoundError'],
      already_exists: [409, 'AlreadyExistsError'],
      invalid_state: [409, 'InvalidStateError'],
      invalid_argument: [400, 'InvalidArgumentError'],
      stopped: [409, 'StoppedError'],
      resource_exhausted: [429, 'ResourceExhaustedError'],
      session_reaped: [410, 'SessionReapedError'],
      internal: [500, 'InternalError'],
      config_error: [500, 'ConfigError'],
      storage_error: [500, 'StorageError'],
      image_pull_failed: [422, 'ImageError'],
      network_unavailable: [503, 'NetworkError'],
      execution_failed: [422, 'ExecutionError'],
      engine_unavailable: [503, 'EngineError'],
      database_error: [500, 'DatabaseError'],
      upstream_unavailable: [503, 'UpstreamUnavailableError'],
      metadata_error: [500, 'MetadataError'],
    }
    const classification = typeof envelope.code === 'string' ? fileCodes[envelope.code] : undefined
    if (classification && classification[0] === status) {
      failure.code = envelope.code as string
      failure.type = classification[1]
      if (
        failure.code === 'unsupported' &&
        typeof envelope.message === 'string' &&
        /(?:is under|would write|contains).*the container's '[^'\r\n]+' mount, which file (?:transfer cannot|transfer cannot read)/.test(
          envelope.message.replace(/\s+/g, ' '),
        )
      ) {
        failure.message =
          'File transfer cannot access container mounts. Stage the file outside the mount and use exec_box to copy it.'
      }
    }
  }
  if ('executionId' in operation && typeof envelope === 'string') {
    const known: [number, string][] = [
      [404, 'execution not found'],
      [404, 'execution does not belong to this box'],
      [409, 'execution is closed'],
      [409, 'execution is being reaped'],
      [400, 'execution is not a TTY'],
    ]
    if (known.some(([expected, prefix]) => expected === status && envelope === `${prefix}: ${operation.executionId}`)) {
      // Do not disclose whether a different Box owns a globally registered execution ID.
      failure.message = status === 404 ? `execution not found: ${operation.executionId}` : envelope
    }
  }
  return new RunnerHttpError(failure.message, failure)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

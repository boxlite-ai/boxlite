/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { runnerHarness, caller, ORGANIZATION_ID } from '../tests/runner-harness'
import { McpFileTools } from '../tools/files/file-tools'
import { McpExecutionTools } from '../tools/execution/execution-tools'
import { McpMetricsTools } from '../tools/metrics/metrics-tools'
import { ForbiddenException, GatewayTimeoutException, RequestTimeoutException } from '@nestjs/common'
import { BoxPreparingImageTimeoutError } from '../../box/errors/box-preparing-image-timeout.error'
import {
  BoxCreationAdmissionUnavailableError,
  BoxCreationLimitExceededError,
} from '../../box/errors/box-creation-limit.error'
import { BoxProgressPhase } from '../../box/enums/box-progress-phase.enum'

describe('MCP structured Runner errors across HTTP', () => {
  let harness: Awaited<ReturnType<typeof runnerHarness>>
  const scope = { organization_id: ORGANIZATION_ID, box_id: 'my box' }

  beforeAll(async () => {
    harness = await runnerHarness((server, access, runner) => {
      new McpFileTools(access, runner).register(server, caller)
      new McpExecutionTools(access, runner).register(server, caller)
      new McpMetricsTools(access, runner).register(server, caller)
    })
  })
  beforeEach(() => harness.reset())
  afterAll(async () => harness.close())

  function fail(status: number, error: unknown) {
    harness.respond((response) => {
      response.writeHead(status)
      response.end(JSON.stringify({ error }))
    })
  }

  describe.each(['lookup', 'resume'])('pre-dispatch service failures during %s', (stage) => {
    it.each([
      [new RequestTimeoutException('Timed out waiting to resume box'), 408, 'timeout', { outcome: 'unknown' }],
      [new GatewayTimeoutException('private upstream timeout details'), 504, 'timeout', { outcome: 'unknown' }],
      [
        new BoxPreparingImageTimeoutError('Box image is still being prepared', {
          phase: BoxProgressPhase.PREPARING_IMAGE,
          retryAfterMs: 12_001,
        }),
        408,
        'timeout',
        { outcome: 'unknown', retry_after_seconds: 13 },
      ],
      [new BoxCreationLimitExceededError(2, 2), 429, 'resource_exhausted', {}],
      [new BoxCreationAdmissionUnavailableError(undefined, 5), 503, 'upstream_unavailable', { retry_after_seconds: 5 }],
      [new ForbiddenException('private admission details'), 403, 'forbidden', {}],
    ])('preserves service metadata (case %#)', async (failure, status, code, metadata) => {
      const fixture = harness.reset()
      fixture.box.autoResume = true
      if (stage === 'lookup') fixture.boxes.findOneByIdOrName.mockRejectedValue(failure)
      else fixture.resume.ensureReady.mockRejectedValue(failure)

      const { result } = await harness.call('exec_box', { ...scope, command: 'true' })

      expect(result.isError).toBe(true)
      expect(result.structuredContent?.error).toEqual({
        source: 'service',
        operation: 'exec_box',
        status,
        code,
        message: expect.any(String),
        ...metadata,
      })
      const message = result.structuredContent.error.message
      if (status === 403) expect(message).toBe('Operation not permitted')
      else if (status === 504) expect(message).not.toContain(failure.message)
      else expect(message).toContain(failure.message)
      if (status === 408 || status === 504) expect(message).toContain('Its outcome is unknown')
      expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent)
      expect(JSON.stringify(result)).not.toContain('private admission details')
      expect(harness.requests).toHaveLength(0)
    })
  })

  it('classifies structured file mount refusal through the tool wrapper', async () => {
    fail(400, {
      code: 'unsupported',
      type: 'UnsupportedError',
      message: "unsupported: /tmp/a is under the container's '/tmp' mount, which file transfer cannot reach",
    })
    const { result } = await harness.call('upload_files', {
      ...scope,
      path: '/tmp/a',
      file: { format: 'utf8', content: 'hello' },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({
        source: 'runner',
        operation: 'upload',
        status: 400,
        code: 'unsupported',
        type: 'UnsupportedError',
      }),
    )
    expect(result.structuredContent?.error?.message).toContain('exec_box')
    expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent)
    expect(harness.requests).toHaveLength(1)
  })

  it.each([
    ['get_execution', 404, 'execution not found: exec-1', 'not_found', 'status'],
    ['resize_execution', 400, 'execution is not a TTY: exec-1', 'invalid_argument', 'resize'],
    ['signal_execution', 409, 'execution is closed: exec-1', 'invalid_state', 'signal'],
  ])('preserves recognized execution errors for %s', async (name, status, message, code, operation) => {
    fail(status as number, message)
    const args = {
      ...scope,
      execution_id: 'exec-1',
      ...(name === 'resize_execution' ? { rows: 24, cols: 80 } : {}),
      ...(name === 'signal_execution' ? { signal: 15 } : {}),
    }
    const { result } = await harness.call(name as string, args)
    expect(result.structuredContent?.error).toEqual({ source: 'runner', operation, status, code, message })
  })

  it.each([
    { code: 'unsupported', type: 'UnsupportedError', message: 'runner-secret mcp-secret' },
    'runner-secret mcp-secret',
    { code: 'not_found', message: 'runner-secret mcp-secret' },
    'x'.repeat(9000),
  ])('never forwards unrecognized or oversized error details', async (error) => {
    fail(400, error)
    const { result } = await harness.call('download_files', { ...scope, path: '/workspace/a' })
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'runner', operation: 'download', status: 400 }),
    )
    expect(JSON.stringify(result)).not.toContain('runner-secret')
    expect(JSON.stringify(result)).not.toContain('mcp-secret')
    expect(JSON.stringify(result).length).toBeLessThan(2000)
  })

  it('carries metrics classification without exposing arbitrary runtime internals', async () => {
    fail(404, 'metrics failed: private-marker')
    const { result } = await harness.call('get_box_metrics', scope)
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'runner', operation: 'metrics', status: 404, code: 'not_found' }),
    )
    expect(JSON.stringify(result)).not.toContain('private-marker')
  })

  it('does not reveal whether another Box owns the execution identifier', async () => {
    fail(404, 'execution not found: exec-1')
    const missing = await harness.call('get_execution', { ...scope, execution_id: 'exec-1' })
    fail(404, 'execution does not belong to this box: exec-1')
    const foreign = await harness.call('get_execution', { ...scope, execution_id: 'exec-1' })
    expect(foreign.result.structuredContent?.error).toEqual({
      source: 'runner',
      operation: 'status',
      status: 404,
      code: 'not_found',
      message: 'execution not found: exec-1',
    })
    expect(foreign.result).toEqual(missing.result)
    expect(JSON.stringify(foreign)).not.toContain('does not belong')
  })

  it('preserves unknown outcomes after a mutation disconnect without replay', async () => {
    harness.respond((response) => response.destroy())
    const { result } = await harness.call('exec_box', { ...scope, command: 'true' })
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'runner', operation: 'exec', outcome: 'unknown' }),
    )
    expect(harness.requests).toHaveLength(1)
  })

  it('classifies invalid successful execution replies as uncertain Runner results', async () => {
    harness.respond((response) => {
      response.writeHead(201)
      response.end('not-json private-marker')
    })
    const { result } = await harness.call('exec_box', { ...scope, command: 'true' })
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'runner', operation: 'exec', code: 'invalid_response', outcome: 'unknown' }),
    )
    expect(JSON.stringify(result)).not.toContain('private-marker')
    expect(harness.requests).toHaveLength(1)
  })

  it('bounds a stalled error body using the existing request deadline', async () => {
    const originalTimeout = global.setTimeout
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback, delay, ...args) =>
        originalTimeout(callback, delay === 30_000 ? 25 : delay, ...args)) as typeof setTimeout)
    try {
      harness.respond((response) => {
        response.writeHead(400)
        response.write('{')
      })
      const { result } = await harness.call('download_files', { ...scope, path: '/workspace/a' })
      expect(result.structuredContent?.error).toEqual(
        expect.objectContaining({ source: 'runner', operation: 'download', status: 400 }),
      )
      expect(harness.requests).toHaveLength(1)
    } finally {
      timer.mockRestore()
    }
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  NotImplementedException,
  RequestTimeoutException,
} from '@nestjs/common'
import * as z from 'zod'
import { BoxCreationLimitExceededError } from '../../box/errors/box-creation-limit.error'
import { ImageColdPullRateLimitedError } from '../../image/errors/image-admission.error'
import { toolHarness } from '../tests/tool-harness'
import { registerMcpTool } from '../tools/shared/mcp-tool'

describe('MCP structured service errors', () => {
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let failure: unknown
  let reply: unknown

  beforeAll(async () => {
    harness = await toolHarness((server) =>
      registerMcpTool(
        server,
        'create_box',
        {
          description: 'Error boundary probe',
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({ ok: z.boolean() }),
          annotations: {},
        },
        async () => {
          if (failure) throw failure
          return reply as { ok: boolean }
        },
      ),
    )
  })
  beforeEach(() => {
    failure = undefined
    reply = { ok: true }
  })
  afterAll(async () => harness.close())

  it('preserves real quota exception classification and public context', async () => {
    failure = new BoxCreationLimitExceededError(2, 2)
    const { result } = await harness.call('create_box', {})
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: {
        source: 'service',
        operation: 'create_box',
        status: 429,
        code: 'resource_exhausted',
        message: 'Organization box creation limit reached: 2 of 2 boxes are already counted',
      },
    })
    expect(result.content[0].text).toBe(result.structuredContent?.error?.message)
    expect(JSON.parse(result.content[1].text)).toEqual(result.structuredContent)
  })

  it('preserves retry timing from the real image pull limit exception', async () => {
    failure = new ImageColdPullRateLimitedError(3, 60, 12)
    const { result } = await harness.call('create_box', {})
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({
        source: 'service',
        status: 429,
        code: 'image_cold_pull_rate_limited',
        retry_after_seconds: 12,
      }),
    )
    expect(result.structuredContent?.error?.message).toContain('12s left')
  })

  it('projects business messages and codes without arbitrary exception fields', async () => {
    failure = new ConflictException({
      message: 'Alias already exists; delete it first',
      code: 'already_exists',
      private: 'private-marker',
    })
    const { result } = await harness.call('create_box', {})
    expect(result.structuredContent?.error).toEqual({
      source: 'service',
      operation: 'create_box',
      status: 409,
      code: 'already_exists',
      message: 'Alias already exists; delete it first',
    })
    expect(JSON.stringify(result)).not.toContain('private-marker')
    failure = new BadRequestException({ message: ['Invalid network', 'Invalid mount'] })
    expect((await harness.call('create_box', {})).result.structuredContent?.error?.message).toBe(
      'Invalid network; Invalid mount',
    )
  })

  it('retains deliberately public unsupported errors and hides internal details', async () => {
    failure = new NotImplementedException({
      message: 'Private registries are not enabled in this deployment',
      code: 'unsupported',
    })
    expect((await harness.call('create_box', {})).result.structuredContent?.error).toEqual(
      expect.objectContaining({
        status: 501,
        code: 'unsupported',
        message: 'Private registries are not enabled in this deployment',
      }),
    )
    for (const error of [new Error('private-marker'), new InternalServerErrorException('private-marker')]) {
      failure = error
      const { result } = await harness.call('create_box', {})
      expect(result.structuredContent?.error).toEqual(
        expect.objectContaining({
          source: 'service',
          status: 500,
          code: 'internal_error',
          message: 'Tool operation failed',
        }),
      )
      expect(JSON.stringify(result)).not.toContain('private-marker')
    }
  })

  it('keeps success values unchanged and advertises a strict error alternative', async () => {
    const { result } = await harness.call('create_box', {})
    expect(result.structuredContent).toEqual({ ok: true })
    const catalog = await harness.list()
    expect(catalog.result.tools[0].outputSchema.anyOf?.[1]?.properties.error.additionalProperties).toBe(false)
    reply = { wrong: true }
    const invalid = await harness.call('create_box', {})
    expect(invalid.result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'mcp', code: 'internal_error' }),
    )
  })

  it('preserves uncertainty when service readiness times out after admission', async () => {
    failure = new RequestTimeoutException('Timed out waiting for volume volume-1 to become ready')
    const { result } = await harness.call('create_box', {})
    expect(result.structuredContent?.error).toEqual(
      expect.objectContaining({ source: 'service', status: 408, code: 'timeout', outcome: 'unknown' }),
    )
    expect(result.content[0].text).toContain('Timed out waiting for volume volume-1')
    expect(result.content[0].text).toContain('outcome is unknown')
  })

  it('keeps resource-denial details private and bounds public message projection', async () => {
    failure = new NotFoundException('private resource details')
    const denied = await harness.call('create_box', {})
    expect(denied.result.structuredContent?.error).toEqual(
      expect.objectContaining({ status: 404, code: 'not_found', message: 'Resource not found or not accessible' }),
    )
    expect(JSON.stringify(denied)).not.toContain('private resource details')
    failure = new BadRequestException({ message: 'x'.repeat(4000), code: 'INVALID-CODE', extra: 'private-marker' })
    const invalid = await harness.call('create_box', {})
    expect(invalid.result.structuredContent?.error?.message).toHaveLength(2048)
    expect(invalid.result.structuredContent?.error?.code).toBe('invalid_argument')
    expect(JSON.stringify(invalid)).not.toContain('private-marker')
    failure = new BadRequestException('invalid\u0000private-marker')
    const control = await harness.call('create_box', {})
    expect(control.result.structuredContent?.error?.message).toBe('Invalid tool request')
    expect(JSON.stringify(control)).not.toContain('private-marker')
  })
})

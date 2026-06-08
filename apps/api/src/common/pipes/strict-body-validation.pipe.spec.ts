/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentMetadata, BadRequestException } from '@nestjs/common'
import { strictBodyValidationPipe } from './strict-body-validation.pipe'
import { CreateBoxDto } from '../../boxlite-rest/dto/create-box.dto'
import { CreateSandboxDto } from '../../sandbox/dto/create-sandbox.dto'

/**
 * Verifies the scoped pipe rejects unsupported body fields instead of silently
 * dropping them. Runs the real pipe against the real creation DTOs — the same
 * objects wired onto the box/sandbox creation handlers.
 */
describe('strictBodyValidationPipe', () => {
  const boxMeta: ArgumentMetadata = { type: 'body', metatype: CreateBoxDto, data: undefined }
  const sandboxMeta: ArgumentMetadata = { type: 'body', metatype: CreateSandboxDto, data: undefined }

  it('rejects an unknown field on CreateBoxDto and names it', async () => {
    await expect(
      strictBodyValidationPipe.transform({ image: 'alpine:latest', auto_delete_minutes: 5 }, boxMeta),
    ).rejects.toBeInstanceOf(BadRequestException)

    try {
      await strictBodyValidationPipe.transform({ image: 'alpine:latest', auto_delete_minutes: 5 }, boxMeta)
      fail('expected BadRequestException')
    } catch (err) {
      const messages = (err as BadRequestException).getResponse() as { message: string[] }
      expect(JSON.stringify(messages.message)).toContain('auto_delete_minutes')
      expect(JSON.stringify(messages.message)).toContain('should not exist')
    }
  })

  it('rejects an unknown field on CreateSandboxDto', async () => {
    await expect(
      strictBodyValidationPipe.transform({ snapshot: 'ubuntu', auto_stop_minutes: 5 }, sandboxMeta),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('accepts a fully-supported CreateBoxDto body', async () => {
    const result = await strictBodyValidationPipe.transform(
      { image: 'alpine:latest', cpus: 2, memory_mib: 256, auto_remove: false, detach: false },
      boxMeta,
    )
    expect(result.image).toBe('alpine:latest')
    expect(result.cpus).toBe(2)
    expect(result.auto_remove).toBe(false)
  })

  it('accepts a fully-supported CreateSandboxDto body', async () => {
    const result = await strictBodyValidationPipe.transform(
      { snapshot: 'ubuntu:24.04', cpu: 2, memory: 4, autoDeleteInterval: 30 },
      sandboxMeta,
    )
    expect(result.snapshot).toBe('ubuntu:24.04')
    expect(result.autoDeleteInterval).toBe(30)
  })
})

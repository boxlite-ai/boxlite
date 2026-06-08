/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateBoxDto } from './create-box.dto'

// A box with 0 vCPUs can never boot (libkrun set_vm_config(0, ...) -> EINVAL),
// so the create endpoint must reject undersized resources at the request
// boundary. These assert the @Min constraints stay wired on CreateBoxDto —
// drop a decorator and the matching case goes red. (The global ValidationPipe
// in main.ts turns these constraint violations into HTTP 400s; that wiring is
// verified live, not here.)
describe('CreateBoxDto resource minimums', () => {
  it.each([
    ['cpus', { cpus: 0 }],
    ['memory_mib', { memory_mib: 128 }],
    ['disk_size_gb', { disk_size_gb: 0 }],
  ])('rejects undersized %s with a min constraint', async (field, body) => {
    const errors = await validate(plainToInstance(CreateBoxDto, body))

    const fieldError = errors.find((e) => e.property === field)
    expect(fieldError?.constraints).toHaveProperty('min')
  })

  it('accepts values exactly at the minimum boundary', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { cpus: 1, memory_mib: 256, disk_size_gb: 1 }))

    expect(errors).toHaveLength(0)
  })

  it('accepts a request that omits resource fields (engine defaults)', async () => {
    const errors = await validate(plainToInstance(CreateBoxDto, { image: 'alpine:3.23' }))

    expect(errors).toHaveLength(0)
  })
})

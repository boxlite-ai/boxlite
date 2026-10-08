/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { assertWithinPerBoxLimits } from './per-box-limits'

const limits = { maxCpuPerBox: 4, maxMemoryPerBox: 8, maxDiskPerBox: 20 }

describe('assertWithinPerBoxLimits', () => {
  it('allows a request within the per-box limits', () => {
    expect(() => assertWithinPerBoxLimits(4, 8, 20, limits)).not.toThrow()
    expect(() => assertWithinPerBoxLimits(1, 1, 10, limits)).not.toThrow()
  })

  it('rejects cpu above the per-box limit (the cpu=999 leak)', () => {
    expect(() => assertWithinPerBoxLimits(999, 8, 20, limits)).toThrow(BadRequestException)
  })

  it('rejects cpu above the org limit that the guest kernel would still allow', () => {
    expect(() => assertWithinPerBoxLimits(8, 8, 20, limits)).toThrow(/cpu 8 exceeds the per-box limit of 4/)
  })

  it('rejects memory above the per-box limit (the 8 PiB leak)', () => {
    // 8_192_000_000 MiB === the absurd value that used to be persisted.
    expect(() => assertWithinPerBoxLimits(4, 8_192_000_000, 20, limits)).toThrow(BadRequestException)
  })

  it('rejects disk above the per-box limit', () => {
    expect(() => assertWithinPerBoxLimits(4, 8, 9999, limits)).toThrow(BadRequestException)
  })

  it('reports every violated dimension in one message', () => {
    expect(() => assertWithinPerBoxLimits(999, 999, 999, limits)).toThrow(/cpu .*memory .*disk/s)
  })

  it('treats a non-positive limit as unset (not enforced)', () => {
    const unset = { maxCpuPerBox: 0, maxMemoryPerBox: 0, maxDiskPerBox: 0 }
    expect(() => assertWithinPerBoxLimits(16, 999, 999, unset)).not.toThrow()
  })

  it('rejects cpu above the guest kernel limit even when the org limit allows it', () => {
    const generous = { maxCpuPerBox: 64, maxMemoryPerBox: 0, maxDiskPerBox: 0 }
    const unset = { maxCpuPerBox: 0, maxMemoryPerBox: 0, maxDiskPerBox: 0 }
    expect(() => assertWithinPerBoxLimits(16, 1, 1, generous)).not.toThrow()
    expect(() => assertWithinPerBoxLimits(17, 1, 1, generous)).toThrow(/cpu 17 .*limit of 16/)
    expect(() => assertWithinPerBoxLimits(24, 1, 1, unset)).toThrow(BadRequestException)
  })
})

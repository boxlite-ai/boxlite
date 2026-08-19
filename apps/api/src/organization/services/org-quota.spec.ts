/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common'
import { assertWithinOrgQuota, OrgQuotaLimits, OrgResourceUsage } from './org-quota'

const limits: OrgQuotaLimits = {
  totalCpuQuota: 10,
  totalMemoryQuota: 40,
  totalDiskQuota: 30,
  totalGpuQuota: 0,
  maxConcurrentBoxes: 10,
}

const usage = (over: Partial<OrgResourceUsage> = {}): OrgResourceUsage => ({
  cpu: 0,
  memory: 0,
  disk: 0,
  gpu: 0,
  count: 0,
  ...over,
})

describe('assertWithinOrgQuota', () => {
  it('allows projected usage within every ceiling', () => {
    expect(() => assertWithinOrgQuota(limits, usage({ cpu: 10, memory: 40, disk: 30, count: 10 }), 0)).not.toThrow()
  })

  it('rejects cpu over the total quota', () => {
    expect(() => assertWithinOrgQuota(limits, usage({ cpu: 11 }), 0)).toThrow(BadRequestException)
  })

  it('rejects memory over the total quota', () => {
    expect(() => assertWithinOrgQuota(limits, usage({ memory: 41 }), 0)).toThrow(BadRequestException)
  })

  it('rejects disk over the total quota', () => {
    expect(() => assertWithinOrgQuota(limits, usage({ disk: 31 }), 0)).toThrow(BadRequestException)
  })

  it('rejects the 11th concurrent box when max is 10', () => {
    expect(() => assertWithinOrgQuota(limits, usage({ count: 10 }), 0)).not.toThrow()
    try {
      assertWithinOrgQuota(limits, usage({ count: 11 }), 0)
      throw new Error('expected concurrency admission to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException)
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
    }
  })

  it('treats a null concurrent-box limit as unlimited', () => {
    expect(() =>
      assertWithinOrgQuota({ ...limits, maxConcurrentBoxes: null }, usage({ count: 10_000 }), 0),
    ).not.toThrow()
  })

  it('fast-rejects a GPU request when the org has no GPU quota', () => {
    expect(() => assertWithinOrgQuota(limits, usage(), 1)).toThrow(/GPU boxes are not available/)
  })

  it('enforces a GPU total when the org does have GPU quota', () => {
    const gpuLimits = { ...limits, totalGpuQuota: 2 }
    expect(() => assertWithinOrgQuota(gpuLimits, usage({ gpu: 2 }), 2)).not.toThrow()
    expect(() => assertWithinOrgQuota(gpuLimits, usage({ gpu: 3 }), 1)).toThrow(BadRequestException)
  })

  it('treats a ceiling of 0 as deny-all (upstream semantics)', () => {
    const zero: OrgQuotaLimits = {
      totalCpuQuota: 0,
      totalMemoryQuota: 0,
      totalDiskQuota: 0,
      totalGpuQuota: 0,
      maxConcurrentBoxes: 0,
    }
    expect(() => assertWithinOrgQuota(zero, usage({ cpu: 2 }), 0)).toThrow(BadRequestException)
    expect(() => assertWithinOrgQuota(zero, usage({ count: 1 }), 0)).toThrow(/concurrent box limit/)
    // exactly-at-zero usage is still allowed (nothing consumed)
    expect(() => assertWithinOrgQuota(zero, usage(), 0)).not.toThrow()
  })

  it('reports every violated dimension in one message', () => {
    try {
      assertWithinOrgQuota(limits, usage({ cpu: 99, memory: 99, disk: 99, count: 99 }), 0)
      throw new Error('expected quota admission to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException)
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
      expect((error as Error).message).toMatch(/CPU .*memory .*disk .*concurrent/s)
    }
  })
})

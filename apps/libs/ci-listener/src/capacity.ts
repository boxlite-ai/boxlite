/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { JobNotice } from './jobs'
import type { StateCheck, ExecutionLease } from './state/store'
import type { ExecutionScope } from './execution/model'

export interface CapacityRequest {
  scope: ExecutionScope
  repository: number
  job?: JobNotice
  lease: ExecutionLease
  signal: AbortSignal
}
export interface CapacityLimit {
  maximum: number | null
  domain: 'global' | 'organization' | 'account'
}
export interface CapacityPolicy {
  limits: readonly CapacityLimit[]
  checks?: readonly StateCheck[]
}
export interface CapacityProvider {
  resolve(request: CapacityRequest): Promise<CapacityPolicy>
}

export function captureCapacity(value: CapacityPolicy): CapacityPolicy {
  if (!Array.isArray(value.limits) || !value.limits.length || value.limits.length > 100)
    throw new Error('Invalid CI capacity policy')
  const limits = value.limits.map(({ maximum, domain }) => {
    if (
      (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0)) ||
      !['global', 'organization', 'account'].includes(domain)
    )
      throw new Error('Invalid CI capacity limit')
    return { maximum, domain }
  })
  if (value.checks && (!Array.isArray(value.checks) || value.checks.length > 100))
    throw new Error('Invalid CI capacity checks')
  return { limits, checks: value.checks?.map((check) => ({ ...check })) }
}

export const closedCapacity: CapacityPolicy = { limits: [{ maximum: 0, domain: 'global' }] }

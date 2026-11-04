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
  /** Pure, synchronous membership test over original worker scopes. */
  includes(worker: ExecutionScope, candidate: ExecutionScope): boolean
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
  const limits = value.limits.map(({ maximum, includes }) => {
    if ((maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0)) || typeof includes !== 'function')
      throw new Error('Invalid CI capacity limit')
    return { maximum, includes }
  })
  if (value.checks && (!Array.isArray(value.checks) || value.checks.length > 100))
    throw new Error('Invalid CI capacity checks')
  return { limits, checks: value.checks?.map((check) => ({ ...check })) }
}

export function hasCapacity(
  candidate: ExecutionScope,
  workers: readonly ExecutionScope[],
  policy: CapacityPolicy,
): boolean {
  return policy.limits.every(({ maximum, includes }) => {
    if (!includes(candidate, candidate)) throw new Error('CI capacity policy excludes its candidate')
    return maximum === null || workers.filter((worker) => includes(worker, candidate)).length < maximum
  })
}
export const closedCapacity: CapacityPolicy = { limits: [{ maximum: 0, includes: () => true }] }

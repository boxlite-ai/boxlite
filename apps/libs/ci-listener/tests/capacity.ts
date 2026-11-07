/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { CapacityPolicy } from '../src/capacity'
import type { StateCheck } from '../src/state/store'

export function testCapacity(value: {
  account: number | null
  tenant: number | null
  checks?: readonly StateCheck[]
}): CapacityPolicy {
  return {
    limits: [
      {
        maximum: value.account,
        includes: (worker, candidate) => worker.installation.account.id === candidate.installation.account.id,
      },
      { maximum: value.tenant, includes: (worker, candidate) => worker.organization === candidate.organization },
    ],
    checks: value.checks,
  }
}

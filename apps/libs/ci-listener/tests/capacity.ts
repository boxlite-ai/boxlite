/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { CapacityPolicy } from '../src/capacity'
import type { StateCheck } from '../src/state/store'
export { inspectJournal } from './journal'

export function testCapacity(value: {
  account: number | null
  tenant: number | null
  checks?: readonly StateCheck[]
}): CapacityPolicy {
  return {
    limits: [
      {
        maximum: value.account,
        domain: 'account',
      },
      { maximum: value.tenant, domain: 'organization' },
    ],
    checks: value.checks,
  }
}

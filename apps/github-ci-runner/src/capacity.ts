/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { CapacityPolicy, CapacityProvider, CapacityRequest } from '@boxlite-ai/ci-listener'

export class EnvironmentCapacity implements CapacityProvider {
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid CI_WORKER_MAX')
  }
  async resolve(_request: CapacityRequest): Promise<CapacityPolicy> {
    return { limits: [{ maximum: this.maximum, includes: () => true }] }
  }
}

/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { Box } from '../entities/box.entity'
import { MeteringMode } from '../enums/metering-mode.enum'

export interface RuntimeComputeCapUpdate {
  manager: EntityManager
  boxId: string
  runnerEpoch: string
  runtimeGeneration: number
  leaseExpiresAt: Date
  observedAt: Date
}

export interface RuntimeUsageTransition {
  manager: EntityManager
  previousBox: Box
  currentBox: Box
  transitionAt: Date
  modeOverride?: MeteringMode
}

/**
 * Where the runtime lease reconciler reports what it observed.
 *
 * The reconciler decides which runtime is authoritative and for how long; it
 * does not decide what that is worth. Metering implements this port to turn
 * those observations into usage periods. Until it does, the no-op below is
 * correct rather than merely inert: with no usage periods in existence there
 * is nothing to cap or close.
 */
export interface RuntimeUsageSink {
  /**
   * Bound an open compute period to the lease that justified it. Returns false
   * when there was no period to cap, which tells the caller to open one.
   */
  updateComputeCap(update: RuntimeComputeCapUpdate): Promise<boolean>

  /** Record that a Box moved between metering modes. */
  transition(transition: RuntimeUsageTransition): Promise<void>
}

export const RUNTIME_USAGE_SINK = Symbol('RUNTIME_USAGE_SINK')

export class NoopRuntimeUsageSink implements RuntimeUsageSink {
  async updateComputeCap(): Promise<boolean> {
    // No open period exists to cap, so report "nothing capped" rather than
    // claiming success — the caller's fallback is a transition, also a no-op.
    return false
  }

  async transition(): Promise<void> {}
}

/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_STATES_CONSUMING_COMPUTE, BOX_STATES_CONSUMING_DISK } from '../constants/box-consuming-states.constant'
import { OrgResourceUsage } from './org-quota'

/** The resource fields a box charges against, in its current state. */
export interface BoxUsageInput {
  state: BoxState
  cpu: number
  mem: number
  disk: number
  gpu: number
}

/**
 * What a single box contributes to org usage in its current state: full compute
 * (cpu / memory / gpu + one running slot) while running, disk while running or
 * merely stopped, and nothing once terminal. Mirrors the usage SUM in
 * fetchBoxUsageFromDb.
 */
export function boxUsageContribution(box: BoxUsageInput): OrgResourceUsage {
  const consumesCompute = BOX_STATES_CONSUMING_COMPUTE.includes(box.state)
  const consumesDisk = BOX_STATES_CONSUMING_DISK.includes(box.state)
  return {
    cpu: consumesCompute ? box.cpu : 0,
    memory: consumesCompute ? box.mem : 0,
    gpu: consumesCompute ? box.gpu : 0,
    count: consumesCompute ? 1 : 0,
    disk: consumesDisk ? box.disk : 0,
  }
}

/**
 * The signed change in one resource when a box moves oldState -> newState, given the
 * set of states that consume it: +amount on entering the set, -amount on leaving it,
 * 0 when membership is unchanged.
 */
export function stateTransitionDelta(
  amount: number,
  oldState: BoxState,
  newState: BoxState,
  consumingStates: BoxState[],
): number {
  const wasConsuming = consumingStates.includes(oldState)
  const isConsuming = consumingStates.includes(newState)
  if (!wasConsuming && isConsuming) {
    return amount
  }
  if (wasConsuming && !isConsuming) {
    return -amount
  }
  return 0
}

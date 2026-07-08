/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'

export type UsagePeriodKind = 'running' | 'stopped'
export type UsageLifecycleKind = UsagePeriodKind | 'gone'

export interface UsageTransitionPlan {
  closeOpen: boolean
  openKind: UsagePeriodKind | null
}

export interface UsagePeriodLike {
  startAt: Date
  endAt: Date | null
  kind: UsagePeriodKind
  cpu: number
  mem: number
  disk: number
  gpu: number
}

export interface UsageTotals {
  cpuSeconds: number
  memGibSeconds: number
  diskGibSeconds: number
  gpuSeconds: number
}

export function usagePeriodKind(state: BoxState, desiredState?: BoxDesiredState): UsageLifecycleKind {
  switch (state) {
    case BoxState.STARTED:
      return 'running'
    case BoxState.RESIZING:
      return desiredState === BoxDesiredState.STARTED ? 'running' : 'stopped'
    case BoxState.DESTROYING:
    case BoxState.DESTROYED:
      return 'gone'
    default:
      return 'stopped'
  }
}

export function planUsageTransition(
  openKind: UsagePeriodKind | null,
  newState: BoxState,
  desiredState?: BoxDesiredState,
): UsageTransitionPlan {
  const nextKind = usagePeriodKind(newState, desiredState)

  if (nextKind === 'gone') {
    return { closeOpen: openKind !== null, openKind: null }
  }

  if (openKind === nextKind) {
    return { closeOpen: false, openKind: null }
  }

  return { closeOpen: openKind !== null, openKind: nextKind }
}

export function aggregateUsagePeriods(periods: UsagePeriodLike[], from: Date, to: Date): UsageTotals {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  const totals: UsageTotals = {
    cpuSeconds: 0,
    memGibSeconds: 0,
    diskGibSeconds: 0,
    gpuSeconds: 0,
  }

  for (const period of periods) {
    const overlapStart = Math.max(period.startAt.getTime(), fromMs)
    const overlapEnd = Math.min((period.endAt ?? to).getTime(), toMs)
    if (overlapEnd <= overlapStart) {
      continue
    }

    const seconds = (overlapEnd - overlapStart) / 1000
    totals.diskGibSeconds += period.disk * seconds
    if (period.kind === 'running') {
      totals.cpuSeconds += period.cpu * seconds
      totals.memGibSeconds += period.mem * seconds
      totals.gpuSeconds += period.gpu * seconds
    }
  }

  return totals
}

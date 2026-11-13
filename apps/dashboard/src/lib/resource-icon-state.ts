/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { BoxState, VolumeState, type Box } from '@boxlite-ai/api-client'

export const RESOURCE_ICON_COLORS = {
  neutral: 'hsl(var(--muted-foreground))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  error: 'hsl(var(--destructive))',
  bound: 'hsl(var(--brand))',
} as const

export type ResourceIconState = {
  tone: keyof typeof RESOURCE_ICON_COLORS
  active: boolean
}

/** Icon accents only; existing status labels, markers and action rules are independent. */
export function getBoxIconState(box: Pick<Box, 'state'>): ResourceIconState {
  switch (box.state) {
    case BoxState.STARTED:
      return { tone: 'success', active: false }
    case BoxState.ERROR:
      return { tone: 'error', active: false }
    case BoxState.CREATING:
    case BoxState.STARTING:
    case BoxState.RESTORING:
    case BoxState.STOPPING:
    case BoxState.DESTROYING:
    case BoxState.RESIZING:
    case BoxState.ARCHIVING:
      return { tone: 'warning', active: true }
    default:
      return { tone: 'neutral', active: false }
  }
}

/** Waiting for storage work is distinct from actively executing it. */
export function getVolumeIconState(state: string): ResourceIconState {
  switch (state) {
    case VolumeState.READY:
      return { tone: 'success', active: false }
    case VolumeState.CREATING:
    case VolumeState.DELETING:
      return { tone: 'warning', active: true }
    case VolumeState.PENDING_CREATE:
    case VolumeState.PENDING_DELETE:
      return { tone: 'warning', active: false }
    case VolumeState.ERROR:
      return { tone: 'error', active: false }
    default:
      return { tone: 'neutral', active: false }
  }
}

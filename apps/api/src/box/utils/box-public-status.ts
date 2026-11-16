/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { BoxState } from '../enums/box-state.enum'

export const BOX_PUBLIC_STATUSES = [
  'configured',
  'running',
  'stopping',
  'stopped',
  'paused',
  'failed',
  'unknown',
] as const
export type BoxPublicStatus = (typeof BOX_PUBLIC_STATUSES)[number]

/** The portable response projection, shared by serialization and inventory selection. */
export function publicBoxStatus(state: string | undefined): BoxPublicStatus {
  switch (state) {
    case BoxState.STARTED:
      return 'running'
    case BoxState.STOPPED:
    case BoxState.ARCHIVED:
      return 'stopped'
    case BoxState.CREATING:
    case BoxState.STARTING:
    case BoxState.RESTORING:
      return 'configured'
    case BoxState.STOPPING:
    case BoxState.DESTROYING:
    case BoxState.ARCHIVING:
      return 'stopping'
    default:
      return 'unknown'
  }
}

/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { CubeState } from '@/components/BoxCube'
import { Box, BoxState, NetworkMode } from '@boxlite-ai/api-client'

/**
 * One noun, three shapes. The API has no `shape` field; the shape is what the
 * box's settings add up to, and it is what decides which surface a screen leads
 * with — a reachable box (inbound access enabled) is its URL, a disposable one
 * is its shell.
 */
export type BoxShape = 'reachable' | 'persistent' | 'disposable'

/** Whether the services the box exposes are reachable without signing in. */
export function isInboundEnabled(box: Pick<Box, 'network'>): boolean {
  return box.network?.inbound.mode === NetworkMode.ENABLED
}

export function boxShape(box: Pick<Box, 'network' | 'autoDelete'>): BoxShape {
  if (isInboundEnabled(box)) return 'reachable'
  // `autoDelete` is minutes-after-stop. The API's "disabled" value is 0
  // (AUTO_DELETE_DISABLED), which is also the column default and what the
  // Create dialog sends for "Never" — so only a positive value is a box that
  // is meant to go away on its own.
  if (typeof box.autoDelete === 'number' && box.autoDelete > 0) return 'disposable'
  return 'persistent'
}

/** The drawing to use for this box: its shape, unless its state overrides it. */
export function boxCubeState(box: Pick<Box, 'network' | 'autoDelete' | 'state'>): CubeState {
  if (box.state === BoxState.ERROR) return 'error'
  if (box.state === BoxState.STOPPED || box.state === BoxState.DESTROYED) return 'stopped'
  return boxShape(box)
}

export const SHAPE_LABEL: Record<BoxShape, string> = {
  reachable: 'reachable',
  persistent: 'persistent',
  disposable: 'disposable',
}

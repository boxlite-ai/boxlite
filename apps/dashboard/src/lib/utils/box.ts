/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState } from '@boxlite-ai/api-client'
import { getBoxDisplayName, getBoxPublicId } from '../box-identity'

export function isStartable(box: Box): boolean {
  return box.state === BoxState.STOPPED
}

export function isStoppable(box: Box): boolean {
  return box.state === BoxState.STARTED
}

export function isSshAccessible(box: Box): boolean {
  return box.state === BoxState.STARTED
}

export function isRecoverable(box: Box): boolean {
  return box.state === BoxState.ERROR && box.recoverable === true
}

export function isDeletable(_box: Box): boolean {
  return true
}

export function isTransitioning(box: Box): boolean {
  return (
    box.state === BoxState.CREATING ||
    box.state === BoxState.STARTING ||
    box.state === BoxState.STOPPING ||
    box.state === BoxState.DESTROYING ||
    box.state === BoxState.RESTORING ||
    box.state === BoxState.BUILDING_ARTIFACT
  )
}

export function getBoxDisplayLabel(box: Box): string {
  const displayName = getBoxDisplayName(box)
  const publicId = getBoxPublicId(box)
  return publicId ? `${displayName} (${publicId})` : displayName
}

export function filterStartable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isStartable)
}

export function filterStoppable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isStoppable)
}

export function filterDeletable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isDeletable)
}

export interface BulkActionCounts {
  startable: number
  stoppable: number
  deletable: number
}

export function getBulkActionCounts(boxes: Box[]): BulkActionCounts {
  return {
    startable: filterStartable(boxes).length,
    stoppable: filterStoppable(boxes).length,
    deletable: filterDeletable(boxes).length,
  }
}

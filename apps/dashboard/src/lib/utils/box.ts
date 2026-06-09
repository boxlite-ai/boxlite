/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState } from '@boxlite-ai/api-client'

export function isStartable(box: Box): boolean {
  return box.state === BoxState.STOPPED || box.state === BoxState.ARCHIVED
}

export function isStoppable(box: Box): boolean {
  return box.state === BoxState.STARTED
}

export function isArchivable(box: Box): boolean {
  return box.state === BoxState.STOPPED
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
    box.state === BoxState.ARCHIVING ||
    box.state === BoxState.RESTORING ||
    box.state === BoxState.BUILDING_SNAPSHOT ||
    box.state === BoxState.PULLING_SNAPSHOT
  )
}

export function getBoxDisplayLabel(box: Box): string {
  return box.name ? `${box.name} (${box.id})` : box.id
}

export function filterStartable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isStartable)
}

export function filterStoppable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isStoppable)
}

export function filterArchivable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isArchivable)
}

export function filterDeletable<T extends Box>(boxes: T[]): T[] {
  return boxes.filter(isDeletable)
}

export interface BulkActionCounts {
  startable: number
  stoppable: number
  archivable: number
  deletable: number
}

export function getBulkActionCounts(boxes: Box[]): BulkActionCounts {
  return {
    startable: filterStartable(boxes).length,
    stoppable: filterStoppable(boxes).length,
    archivable: filterArchivable(boxes).length,
    deletable: filterDeletable(boxes).length,
  }
}

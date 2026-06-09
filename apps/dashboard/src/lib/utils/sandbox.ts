/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox, SandboxState } from '@boxlite-ai/api-client'
import { getSandboxDisplayName, getSandboxPublicId } from '../sandbox-identity'

export function isStartable(sandbox: Sandbox): boolean {
  return sandbox.state === SandboxState.STOPPED
}

export function isStoppable(sandbox: Sandbox): boolean {
  return sandbox.state === SandboxState.STARTED
}

export function isSshAccessible(sandbox: Sandbox): boolean {
  return sandbox.state === SandboxState.STARTED
}

export function isRecoverable(sandbox: Sandbox): boolean {
  return sandbox.state === SandboxState.ERROR && sandbox.recoverable === true
}

export function isDeletable(_sandbox: Sandbox): boolean {
  return true
}

export function isTransitioning(sandbox: Sandbox): boolean {
  return (
    sandbox.state === SandboxState.CREATING ||
    sandbox.state === SandboxState.STARTING ||
    sandbox.state === SandboxState.STOPPING ||
    sandbox.state === SandboxState.DESTROYING ||
    sandbox.state === SandboxState.RESTORING ||
    sandbox.state === SandboxState.BUILDING_ARTIFACT ||
    sandbox.state === SandboxState.PULLING_ARTIFACT
  )
}

export function getSandboxDisplayLabel(sandbox: Sandbox): string {
  const displayName = getSandboxDisplayName(sandbox)
  const publicId = getSandboxPublicId(sandbox)
  return publicId ? `${displayName} (${publicId})` : displayName
}

export function filterStartable<T extends Sandbox>(sandboxes: T[]): T[] {
  return sandboxes.filter(isStartable)
}

export function filterStoppable<T extends Sandbox>(sandboxes: T[]): T[] {
  return sandboxes.filter(isStoppable)
}

export function filterDeletable<T extends Sandbox>(sandboxes: T[]): T[] {
  return sandboxes.filter(isDeletable)
}

export interface BulkActionCounts {
  startable: number
  stoppable: number
  deletable: number
}

export function getBulkActionCounts(sandboxes: Sandbox[]): BulkActionCounts {
  return {
    startable: filterStartable(sandboxes).length,
    stoppable: filterStoppable(sandboxes).length,
    deletable: filterDeletable(sandboxes).length,
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox, SandboxDesiredState } from '@boxlite-ai/api-client'

type SandboxIdentity = Pick<Sandbox, 'id' | 'name'> & Partial<Pick<Sandbox, 'boxId' | 'desiredState'>>

export const MISSING_BOX_ID_LABEL = 'Not available'

export function getSandboxPublicId(sandbox: Partial<Pick<Sandbox, 'boxId'>> | undefined): string {
  return sandbox?.boxId || ''
}

export function getSandboxPublicIdLabel(sandbox: Partial<Pick<Sandbox, 'boxId'>> | undefined): string {
  return getSandboxPublicId(sandbox) || MISSING_BOX_ID_LABEL
}

export function getSandboxRouteId(sandbox: Partial<Pick<Sandbox, 'boxId' | 'id'>> | undefined): string {
  return sandbox?.boxId || sandbox?.id || ''
}

export function getSandboxDisplayName(sandbox: SandboxIdentity): string {
  const name = getNormalizedSandboxName(sandbox)
  if (name && name !== sandbox.id && !isUuidLike(name)) {
    return name
  }
  return getSandboxPublicId(sandbox) || 'Box'
}

function getNormalizedSandboxName(sandbox: SandboxIdentity): string {
  if (sandbox.desiredState === SandboxDesiredState.DESTROYED && sandbox.name.startsWith('DESTROYED_')) {
    const withoutPrefix = sandbox.name.substring(10)
    const lastUnderscoreIndex = withoutPrefix.lastIndexOf('_')
    if (lastUnderscoreIndex !== -1) {
      return withoutPrefix.substring(0, lastUnderscoreIndex)
    }
    return withoutPrefix
  }

  return sandbox.name
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

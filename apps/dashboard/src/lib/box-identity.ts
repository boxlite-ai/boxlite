/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxDesiredState } from '@boxlite-ai/api-client'

type BoxIdentity = Pick<Box, 'id' | 'name'> & Partial<Pick<Box, 'desiredState'>>

export const MISSING_BOX_ID_LABEL = 'Not available'

export function getBoxPublicId(box: Partial<Pick<Box, 'id'>> | undefined): string {
  return box?.id || ''
}

export function getBoxPublicIdLabel(box: Partial<Pick<Box, 'id'>> | undefined): string {
  return getBoxPublicId(box) || MISSING_BOX_ID_LABEL
}

export function getBoxRouteId(box: Partial<Pick<Box, 'id'>> | undefined): string {
  return box?.id || ''
}

export function getBoxDisplayName(box: BoxIdentity): string {
  const name = getNormalizedBoxName(box)
  // An unnamed box falls back to name === id at create time; show the id label then.
  if (name && name !== box.id) {
    return name
  }
  return getBoxPublicId(box) || 'Box'
}

function getNormalizedBoxName(box: BoxIdentity): string {
  if (box.desiredState === BoxDesiredState.DESTROYED && box.name.startsWith('DESTROYED_')) {
    const withoutPrefix = box.name.substring(10)
    const lastUnderscoreIndex = withoutPrefix.lastIndexOf('_')
    if (lastUnderscoreIndex !== -1) {
      return withoutPrefix.substring(0, lastUnderscoreIndex)
    }
    return withoutPrefix
  }

  return box.name
}

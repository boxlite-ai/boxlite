/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxDesiredState } from '@boxlite-ai/api-client'

type BoxIdentity = Pick<Box, 'id' | 'name'> & Partial<Pick<Box, 'boxId' | 'desiredState'>>

export const MISSING_BOX_ID_LABEL = 'Not available'

export function getBoxPublicId(box: Partial<Pick<Box, 'boxId'>> | undefined): string {
  return box?.boxId || ''
}

export function getBoxPublicIdLabel(box: Partial<Pick<Box, 'boxId'>> | undefined): string {
  return getBoxPublicId(box) || MISSING_BOX_ID_LABEL
}

export function getBoxRouteId(box: Partial<Pick<Box, 'boxId' | 'id'>> | undefined): string {
  return box?.boxId || box?.id || ''
}

export function getBoxDisplayName(box: BoxIdentity): string {
  const name = getNormalizedBoxName(box)
  if (name && name !== box.id && !isUuidLike(name)) {
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

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

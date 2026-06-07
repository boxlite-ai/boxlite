/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface SavedImageDisplayMetadata {
  displayName: string
  description: string
}

// The API still exposes SavedImage records. The Dashboard presents those
// records as Images because users choose them as base images when creating sandboxes.
const BUILT_IN_SAVED_IMAGES: Record<string, SavedImageDisplayMetadata> = {
  'ubuntu:24.04': {
    displayName: 'Ubuntu 24.04 LTS',
    description: 'General-purpose Linux image',
  },
  'debian:13-slim': {
    displayName: 'Debian 13 slim',
    description: 'Small Debian-based image',
  },
  'alpine:3.23': {
    displayName: 'Alpine 3.23',
    description: 'Minimal Linux image',
  },
}

const BUILT_IN_SAVED_IMAGE_ORDER = Object.keys(BUILT_IN_SAVED_IMAGES)

export function getSavedImageDisplayMetadata(savedImageName?: string): SavedImageDisplayMetadata | undefined {
  if (!savedImageName) {
    return undefined
  }

  return BUILT_IN_SAVED_IMAGES[savedImageName]
}

export function getSavedImageDisplayName(savedImageName?: string): string {
  if (!savedImageName) {
    return '-'
  }

  return getSavedImageDisplayMetadata(savedImageName)?.displayName ?? savedImageName
}

export function getSavedImageDisplaySortIndex(savedImageName?: string): number {
  if (!savedImageName) {
    return Number.MAX_SAFE_INTEGER
  }

  const index = BUILT_IN_SAVED_IMAGE_ORDER.indexOf(savedImageName)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

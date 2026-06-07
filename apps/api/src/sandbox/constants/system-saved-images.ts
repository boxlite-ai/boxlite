/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface SystemSavedImageDefinition {
  name: string
  imageName: string
  displayName: string
  description: string
}

export const SYSTEM_SAVED_IMAGES: SystemSavedImageDefinition[] = [
  {
    name: 'ubuntu:24.04',
    imageName: 'ubuntu:24.04',
    displayName: 'Ubuntu 24.04 LTS',
    description: 'General-purpose Linux savedImage',
  },
  {
    name: 'debian:13-slim',
    imageName: 'debian:13-slim',
    displayName: 'Debian 13 slim',
    description: 'Small Debian-based savedImage',
  },
  {
    name: 'alpine:3.23',
    imageName: 'alpine:3.23',
    displayName: 'Alpine 3.23',
    description: 'Minimal Linux savedImage',
  },
]

export function getSystemSavedImageDefinition(imageNameOrName: string): SystemSavedImageDefinition | undefined {
  return SYSTEM_SAVED_IMAGES.find(
    (savedImage) => savedImage.imageName === imageNameOrName || savedImage.name === imageNameOrName,
  )
}

export function getSystemSavedImageSortIndex(imageNameOrName: string): number {
  const index = SYSTEM_SAVED_IMAGES.findIndex(
    (savedImage) => savedImage.imageName === imageNameOrName || savedImage.name === imageNameOrName,
  )

  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

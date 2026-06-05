/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface SystemTemplateDefinition {
  name: string
  imageName: string
  displayName: string
  description: string
}

export const SYSTEM_TEMPLATES: SystemTemplateDefinition[] = [
  {
    name: 'ubuntu:24.04',
    imageName: 'ubuntu:24.04',
    displayName: 'Ubuntu 24.04 LTS',
    description: 'General-purpose Linux template',
  },
  {
    name: 'debian:13-slim',
    imageName: 'debian:13-slim',
    displayName: 'Debian 13 slim',
    description: 'Small Debian-based template',
  },
  {
    name: 'alpine:3.23',
    imageName: 'alpine:3.23',
    displayName: 'Alpine 3.23',
    description: 'Minimal Linux template',
  },
]

export function getSystemTemplateDefinition(imageNameOrName: string): SystemTemplateDefinition | undefined {
  return SYSTEM_TEMPLATES.find(
    (template) => template.imageName === imageNameOrName || template.name === imageNameOrName,
  )
}

export function getSystemTemplateSortIndex(imageNameOrName: string): number {
  const index = SYSTEM_TEMPLATES.findIndex(
    (template) => template.imageName === imageNameOrName || template.name === imageNameOrName,
  )

  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

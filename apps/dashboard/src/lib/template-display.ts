/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export interface TemplateDisplayMetadata {
  displayName: string
  description: string
}

// The API still exposes BoxTemplate records. The Dashboard presents those
// records as Images because users choose them as base images when creating sandboxes.
const BUILT_IN_TEMPLATES: Record<string, TemplateDisplayMetadata> = {
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

const BUILT_IN_TEMPLATE_ORDER = Object.keys(BUILT_IN_TEMPLATES)

export function getTemplateDisplayMetadata(templateName?: string): TemplateDisplayMetadata | undefined {
  if (!templateName) {
    return undefined
  }

  return BUILT_IN_TEMPLATES[templateName]
}

export function getTemplateDisplayName(templateName?: string): string {
  if (!templateName) {
    return '-'
  }

  return getTemplateDisplayMetadata(templateName)?.displayName ?? templateName
}

export function getTemplateDisplaySortIndex(templateName?: string): number {
  if (!templateName) {
    return Number.MAX_SAFE_INTEGER
  }

  const index = BUILT_IN_TEMPLATE_ORDER.indexOf(templateName)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

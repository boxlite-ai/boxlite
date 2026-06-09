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
// records as Images because users choose them as base images when creating Boxes.
const BUILT_IN_TEMPLATES: Record<string, TemplateDisplayMetadata> = {
  'boxlite/base': {
    displayName: 'BoxLite Base',
    description: 'General agent runtime with curl, git, jq, SSH, Python basics, and noninteractive apt.',
  },
  'boxlite/python': {
    displayName: 'BoxLite Python',
    description: 'Python runtime with pip, venv, build tools, and HTTPS-ready defaults.',
  },
  'boxlite/node': {
    displayName: 'BoxLite Node',
    description: 'Node.js 22 runtime with npm, corepack, and common agent tools.',
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

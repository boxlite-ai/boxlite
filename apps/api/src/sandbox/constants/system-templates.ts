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
  capabilities: string[]
  aliases?: string[]
}

const SYSTEM_IMAGE_TAG = process.env.BOXLITE_SYSTEM_IMAGE_TAG?.trim() || '20260605-p0-r3'

function systemImageRef(envName: string, repository: string): string {
  return process.env[envName]?.trim() || `ghcr.io/boxlite-ai/${repository}:${SYSTEM_IMAGE_TAG}`
}

export const SYSTEM_TEMPLATES: SystemTemplateDefinition[] = [
  {
    name: 'boxlite/base',
    imageName: systemImageRef('BOXLITE_SYSTEM_BASE_IMAGE', 'boxlite-agent-base'),
    displayName: 'BoxLite Base',
    description: 'General agent runtime with curl, git, jq, SSH, Python basics, and noninteractive apt.',
    capabilities: ['apt-noninteractive', 'ca-certificates', 'curl', 'git', 'jq', 'python', 'ssh'],
    aliases: ['ubuntu:24.04', 'debian:13-slim', 'alpine:3.23'],
  },
  {
    name: 'boxlite/python',
    imageName: systemImageRef('BOXLITE_SYSTEM_PYTHON_IMAGE', 'boxlite-agent-python'),
    displayName: 'BoxLite Python',
    description: 'Python runtime with pip, venv, build tools, and HTTPS-ready defaults.',
    capabilities: ['apt-noninteractive', 'build-essential', 'ca-certificates', 'curl', 'git', 'pip', 'python', 'venv'],
  },
  {
    name: 'boxlite/node',
    imageName: systemImageRef('BOXLITE_SYSTEM_NODE_IMAGE', 'boxlite-agent-node'),
    displayName: 'BoxLite Node',
    description: 'Node.js 22 runtime with npm, corepack, and common agent tools.',
    capabilities: ['apt-noninteractive', 'ca-certificates', 'corepack', 'curl', 'git', 'node', 'npm', 'python'],
  },
]

export function getSystemTemplateDefinition(imageNameOrName: string): SystemTemplateDefinition | undefined {
  const value = imageNameOrName.trim()
  if (!value) {
    return undefined
  }

  return SYSTEM_TEMPLATES.find(
    (template) => template.imageName === value || template.name === value || template.aliases?.includes(value),
  )
}

export function resolveSystemTemplateName(imageNameOrName: string | undefined): string | undefined {
  const value = imageNameOrName?.trim()
  if (!value) {
    return SYSTEM_TEMPLATES[0]?.name
  }

  return getSystemTemplateDefinition(value)?.name
}

export function getSystemTemplateSortIndex(imageNameOrName: string): number {
  const value = imageNameOrName.trim()
  const index = SYSTEM_TEMPLATES.findIndex(
    (template) => template.imageName === value || template.name === value || template.aliases?.includes(value),
  )

  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

export function getAllowedSystemTemplateNames(): string {
  return SYSTEM_TEMPLATES.map((template) => template.name).join(', ')
}

export function getDeprecatedSystemTemplateAliases(): string[] {
  return SYSTEM_TEMPLATES.flatMap((template) => template.aliases ?? [])
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  getSystemTemplateDefinition,
  getSystemTemplateSortIndex,
  resolveSystemTemplateName,
  SYSTEM_TEMPLATES,
} from './system-templates'

describe('system-templates', () => {
  it('exposes only BoxLite agent-ready images in the intended order', () => {
    expect(SYSTEM_TEMPLATES.map((template) => template.name)).toEqual([
      'boxlite/base',
      'boxlite/python',
      'boxlite/node',
    ])
  })

  it('maps image names to user-facing labels, descriptions, and capabilities', () => {
    expect(getSystemTemplateDefinition('boxlite/base')).toMatchObject({
      displayName: 'BoxLite Base',
      description: expect.stringContaining('General agent runtime'),
      capabilities: expect.arrayContaining(['curl', 'git', 'python', 'apt-noninteractive']),
    })
    expect(getSystemTemplateDefinition('boxlite/python')).toMatchObject({
      displayName: 'BoxLite Python',
      capabilities: expect.arrayContaining(['python', 'pip', 'venv']),
    })
    expect(getSystemTemplateDefinition('boxlite/node')).toMatchObject({
      displayName: 'BoxLite Node',
      capabilities: expect.arrayContaining(['node', 'npm']),
    })
  })

  it('keeps legacy approved OS tags as hidden compatibility aliases to the base image', () => {
    expect(getSystemTemplateDefinition('ubuntu:24.04')?.name).toBe('boxlite/base')
    expect(getSystemTemplateDefinition('debian:13-slim')?.name).toBe('boxlite/base')
    expect(getSystemTemplateDefinition('alpine:3.23')?.name).toBe('boxlite/base')
    expect(resolveSystemTemplateName('ubuntu:24.04')).toBe('boxlite/base')
    expect(resolveSystemTemplateName(undefined)).toBe('boxlite/base')
  })

  it('does not treat a blank image name as an explicit system template match', () => {
    expect(getSystemTemplateDefinition('')).toBeUndefined()
  })

  it('provides a stable sort order for known images', () => {
    expect(
      ['boxlite/node', 'boxlite/base', 'boxlite/python'].sort(
        (a, b) => getSystemTemplateSortIndex(a) - getSystemTemplateSortIndex(b),
      ),
    ).toEqual(['boxlite/base', 'boxlite/python', 'boxlite/node'])
  })

  it('pins official catalog entries to prebuilt runtime images instead of runner-side buildInfo', () => {
    for (const template of SYSTEM_TEMPLATES) {
      expect(template.imageName).toMatch(/:.+|@sha256:[a-f0-9]{64}$/)
      expect(template.imageName).not.toContain(':latest')
      expect((template as { buildInfo?: unknown }).buildInfo).toBeUndefined()
      expect(getSystemTemplateDefinition(template.imageName)?.name).toBe(template.name)
    }
  })
})

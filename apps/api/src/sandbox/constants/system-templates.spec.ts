/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getSystemTemplateDefinition, getSystemTemplateSortIndex, SYSTEM_TEMPLATES } from './system-templates'

describe('system-templates', () => {
  it('exposes only MVP Linux base images in the intended order', () => {
    expect(SYSTEM_TEMPLATES.map((template) => template.imageName)).toEqual([
      'ubuntu:24.04',
      'debian:13-slim',
      'alpine:3.23',
    ])
  })

  it('maps image tags to user-facing labels and descriptions', () => {
    expect(getSystemTemplateDefinition('ubuntu:24.04')).toMatchObject({
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
    })
    expect(getSystemTemplateDefinition('debian:13-slim')).toMatchObject({
      displayName: 'Debian 13 slim',
      description: 'Small Debian-based template',
    })
    expect(getSystemTemplateDefinition('alpine:3.23')).toMatchObject({
      displayName: 'Alpine 3.23',
      description: 'Minimal Linux template',
    })
  })

  it('provides a stable sort order for known images', () => {
    expect(
      ['alpine:3.23', 'ubuntu:24.04', 'debian:13-slim'].sort(
        (a, b) => getSystemTemplateSortIndex(a) - getSystemTemplateSortIndex(b),
      ),
    ).toEqual(['ubuntu:24.04', 'debian:13-slim', 'alpine:3.23'])
  })
})

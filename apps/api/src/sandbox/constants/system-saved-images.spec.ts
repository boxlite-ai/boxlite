/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { getSystemSavedImageDefinition, getSystemSavedImageSortIndex, SYSTEM_SAVED_IMAGES } from './system-saved-images'

describe('system-saved-images', () => {
  it('exposes only MVP Linux base images in the intended order', () => {
    expect(SYSTEM_SAVED_IMAGES.map((savedImage) => savedImage.imageName)).toEqual([
      'ubuntu:24.04',
      'debian:13-slim',
      'alpine:3.23',
    ])
  })

  it('maps image tags to user-facing labels and descriptions', () => {
    expect(getSystemSavedImageDefinition('ubuntu:24.04')).toMatchObject({
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux savedImage',
    })
    expect(getSystemSavedImageDefinition('debian:13-slim')).toMatchObject({
      displayName: 'Debian 13 slim',
      description: 'Small Debian-based savedImage',
    })
    expect(getSystemSavedImageDefinition('alpine:3.23')).toMatchObject({
      displayName: 'Alpine 3.23',
      description: 'Minimal Linux savedImage',
    })
  })

  it('provides a stable sort order for known images', () => {
    expect(
      ['alpine:3.23', 'ubuntu:24.04', 'debian:13-slim'].sort(
        (a, b) => getSystemSavedImageSortIndex(a) - getSystemSavedImageSortIndex(b),
      ),
    ).toEqual(['ubuntu:24.04', 'debian:13-slim', 'alpine:3.23'])
  })
})

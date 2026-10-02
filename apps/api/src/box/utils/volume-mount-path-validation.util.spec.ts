/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { validateMountPaths } from './volume-mount-path-validation.util'

function volume(mountPath: string) {
  return { volumeId: 'vol-1', mountPath }
}

describe('volume mount path validation', () => {
  it.each(['/workspace', '/home/user/.cache', '/etcetera'])('accepts %s', (mountPath) => {
    expect(() => validateMountPaths([volume(mountPath)])).not.toThrow()
  })

  it.each([
    ['workspace', 'Invalid mount path workspace (must be absolute)'],
    ['/', 'Invalid mount path / (cannot mount to the root directory)'],
    ['/data/../etc', 'Invalid mount path /data/../etc (cannot contain relative path components)'],
    ['/data//sets', 'Invalid mount path /data//sets (cannot contain consecutive slashes)'],
    ['/proc/self', 'Invalid mount path /proc/self (cannot mount to system directory)'],
  ])('rejects %s', (mountPath, message) => {
    expect(() => validateMountPaths([volume(mountPath)])).toThrow(message)
  })

  it('reports every invalid path, not just the first', () => {
    expect(() => validateMountPaths([volume('relative'), volume('/')])).toThrow(
      'Invalid mount path relative (must be absolute), Invalid mount path / (cannot mount to the root directory)',
    )
  })
})

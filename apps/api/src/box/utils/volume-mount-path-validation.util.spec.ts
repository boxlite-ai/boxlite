/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume } from '../dto/box.dto'
import { validateMountPaths, validateSubpaths } from './volume-mount-path-validation.util'

// The mount-path rules are backend-agnostic by construction: every volume
// reference (managed and filestore alike) carries mountPath at the top level,
// so both shapes must pass the same rules through the same function. Each
// rejection case pins the branch that rejects it via the error message, so a
// case cannot pass merely because an earlier branch also rejects the input.
describe('validateMountPaths', () => {
  it.each([
    ['a managed volume', { volumeId: 'volume-123', mountPath: '/data' }],
    [
      'a filestore volume',
      {
        volumeId: 'volume-123',
        mountPath: '/nfs',
        filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
      },
    ],
    ['a managed volume with a subpath', { volumeId: 'volume-123', mountPath: '/data', subpath: 'users/alice' }],
  ])('accepts an absolute mount path on %s', (_label, volume: BoxVolume) => {
    expect(() => validateMountPaths([volume])).not.toThrow()
  })

  it.each([
    ['a relative path', 'data', 'must be absolute'],
    ['the root directory', '/', 'cannot mount to the root directory'],
    ['a parent traversal', '/data/../etc', 'cannot contain relative path components'],
    ['a relative path with double slashes', 'a//b', 'must be absolute'],
    ['an absolute path with consecutive slashes', '/a//b', 'cannot contain consecutive slashes'],
    ['a system file', '/etc/passwd', 'cannot mount to system directory'],
    ['a directory under a system path', '/etc/nginx/conf', 'cannot mount to system directory'],
  ])('rejects %s', (_label, mountPath: string, message) => {
    const volume: BoxVolume = {
      volumeId: 'volume-123',
      mountPath,
      filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
    }

    expect(() => validateMountPaths([volume])).toThrow(message)
  })

  it('reports every invalid volume, not just the first', () => {
    expect(() =>
      validateMountPaths([
        { volumeId: 'volume-123', mountPath: '/data' },
        {
          volumeId: 'volume-123',
          mountPath: 'relative',
          filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
        },
        {
          volumeId: 'volume-123',
          mountPath: '/proc',
          filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
        },
      ]),
    ).toThrow('must be absolute')
    // toThrow checks the whole joined message; assert the second error is in
    // there too rather than letting the first mask it.
    let thrown: unknown
    try {
      validateMountPaths([
        { volumeId: 'volume-123', mountPath: '/data' },
        {
          volumeId: 'volume-123',
          mountPath: 'relative',
          filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
        },
        {
          volumeId: 'volume-123',
          mountPath: '/proc',
          filestore: { instance: 'ml-scratch', server: '10.0.0.7', export: '/vol1' },
        },
      ])
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toContain('cannot mount to system directory')
  })
})

describe('validateSubpaths', () => {
  it('accepts omitted subpaths and ordinary relative components', () => {
    expect(() => validateSubpaths([{ volumeId: 'vol', mountPath: '/data' }])).not.toThrow()
    expect(() => validateSubpaths([{ volumeId: 'vol', mountPath: '/data', subpath: '' }])).not.toThrow()
    expect(() => validateSubpaths([{ volumeId: 'vol', mountPath: '/data', subpath: 'foo..bar/team' }])).not.toThrow()
  })

  it('rejects separators, traversal, limits, and wrong types', () => {
    const cases = [
      '/team/backend',
      'team//backend',
      '.',
      '..',
      'team/..',
      'foo\0bar',
      'a'.repeat(256),
      `${'a'.repeat(100)}/`.repeat(64) + 'a',
      42,
      null,
    ]

    for (const subpath of cases) {
      expect(() => validateSubpaths([{ volumeId: 'vol', mountPath: '/data', subpath } as any])).toThrow()
    }
  })

  it('normalizes one legacy trailing slash without changing the mount target', () => {
    const volumes = [{ volumeId: 'vol', mountPath: '/data', subpath: 'team/backend/' }] as any
    expect(() => validateSubpaths(volumes)).not.toThrow()
    expect(volumes[0].subpath).toBe('team/backend')
  })

  it('allows exactly 64 components and 4096 bytes', () => {
    const components = Array.from({ length: 64 }, () => 'a')
    expect(() =>
      validateSubpaths([{ volumeId: 'vol', mountPath: '/data', subpath: components.join('/') }]),
    ).not.toThrow()

    const long = Array.from({ length: 17 }, () => 'a'.repeat(240))
    expect(long.join('/')).toHaveLength(4096)
    expect(() => validateSubpaths([{ volumeId: 'vol', mountPath: '/data', subpath: long.join('/') }])).not.toThrow()
  })
})

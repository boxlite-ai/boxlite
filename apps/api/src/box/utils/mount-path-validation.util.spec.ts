/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { BoxMount } from '../dto/box-mount.dto'
import { validateMountSubPaths, validateMountTargets } from './mount-path-validation.util'

function mount(fields: Partial<BoxMount> = {}): BoxMount {
  return { type: 'volume', source: 'run42', target: '/workspace', ...fields }
}

describe('mount target validation', () => {
  it.each(['/workspace', '/data/sets', '/home/user/.cache'])('accepts the absolute target %s', (target) => {
    expect(() => validateMountTargets([mount({ target })])).not.toThrow()
  })

  it.each([
    ['workspace', 'Invalid mount target workspace (must be absolute)'],
    ['/', 'Invalid mount target / (cannot mount to the root directory)'],
    ['/data/../etc', 'Invalid mount target /data/../etc (cannot contain relative path components)'],
    ['/data/.', 'Invalid mount target /data/. (cannot contain relative path components)'],
    ['/data//sets', 'Invalid mount target /data//sets (cannot contain consecutive slashes)'],
    ['/etc', 'Invalid mount target /etc (cannot mount to system directory)'],
    ['/proc/self', 'Invalid mount target /proc/self (cannot mount to system directory)'],
  ])('rejects %s', (target, message) => {
    expect(() => validateMountTargets([mount({ target })])).toThrow(message)
  })

  // A directory whose name merely starts like a system one is not inside it.
  it('accepts /etcetera, which is not under /etc', () => {
    expect(() => validateMountTargets([mount({ target: '/etcetera' })])).not.toThrow()
  })

  it('reports every invalid target, not just the first', () => {
    expect(() => validateMountTargets([mount({ target: 'relative' }), mount({ target: '/' })])).toThrow(
      /must be absolute.*root directory/s,
    )
  })
})

describe('mount sub_path validation', () => {
  it.each(['agents/extract', 'agents/extract/', 'foo/bar'])('accepts the relative prefix %s', (subPath) => {
    expect(() => validateMountSubPaths([mount({ subPath })])).not.toThrow()
  })

  it('accepts an omitted sub_path as the whole volume', () => {
    expect(() => validateMountSubPaths([mount()])).not.toThrow()
  })

  // Omitting sub_path already says "the whole volume", so an empty one is
  // refused instead of being read as a second spelling of it.
  it('rejects an empty sub_path', () => {
    expect(() => validateMountSubPaths([mount({ subPath: '' })])).toThrow(
      'Invalid sub_path "" (omit sub_path to mount the whole volume)',
    )
  })

  // Pinning each parenthetical reason means changing a rule or its wording
  // fails this test. CLI(TODO): once src/cli/src/mountspec.rs
  // (validate_mount_sub_path) mirrors these reasons, that failure is the
  // signal to change the CLI too.
  it.each([
    ['/absolute', 'Invalid sub_path "/absolute" (S3 key prefixes cannot start with /)'],
    ['a/../b', 'Invalid sub_path "a/../b" (cannot contain .. for security)'],
    // `..` is a substring test, so a name that merely contains it is refused too.
    ['a..b/c', 'Invalid sub_path "a..b/c" (cannot contain .. for security)'],
    ['a//b', 'Invalid sub_path "a//b" (cannot contain consecutive slashes)'],
  ])('rejects %s with its reason', (subPath, message) => {
    expect(() => validateMountSubPaths([mount({ subPath })])).toThrow(message)
  })

  it('reports every invalid prefix, not just the first', () => {
    expect(() => validateMountSubPaths([mount({ subPath: '/absolute' }), mount({ subPath: 'a//b' })])).toThrow(
      /cannot start with \/.*consecutive slashes/s,
    )
  })
})

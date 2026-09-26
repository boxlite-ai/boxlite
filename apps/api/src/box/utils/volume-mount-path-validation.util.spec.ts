/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume } from '../dto/box.dto'
import { validateSubpaths } from './volume-mount-path-validation.util'

function mount(subpath?: string): BoxVolume {
  return { volumeId: 'run42', mountPath: '/work', subpath } as BoxVolume
}

describe('volume subpath validation', () => {
  it.each(['agents/extract', 'agents/extract/', 'deep/nested/prefix'])('accepts the relative prefix %s', (subpath) => {
    expect(() => validateSubpaths([mount(subpath)])).not.toThrow()
  })

  // An absent prefix means the whole volume, so omitting it is not an error.
  it.each([undefined, ''])('accepts %p as "the whole volume"', (subpath) => {
    expect(() => validateSubpaths([mount(subpath)])).not.toThrow()
  })

  // The parenthetical reason in each message is reproduced verbatim by the CLI,
  // in
  // src/cli/src/volumespec.rs (validate_sub_path), so that a bad prefix fails
  // before a request is built. Pinning them here means changing a rule or its
  // wording fails this test, which is the signal to change the CLI too; a
  // comment on each side is not enough to catch drift.
  it.each([
    ['/absolute', 'Invalid subpath "/absolute" (S3 key prefixes cannot start with /)'],
    ['../escape', 'Invalid subpath "../escape" (cannot contain .. for security)'],
    ['a/../b', 'Invalid subpath "a/../b" (cannot contain .. for security)'],
    // `..` is a substring test, so a name that merely contains it is refused too.
    ['a..b/c', 'Invalid subpath "a..b/c" (cannot contain .. for security)'],
    ['a//b', 'Invalid subpath "a//b" (cannot contain consecutive slashes)'],
  ])('rejects %s with the message the CLI mirrors', (subpath, message) => {
    expect(() => validateSubpaths([mount(subpath)])).toThrow(message)
  })

  it('reports every invalid mount, not just the first', () => {
    expect(() => validateSubpaths([mount('/absolute'), mount('../escape')])).toThrow(
      /cannot start with \/.*cannot contain \.\./s,
    )
  })
})

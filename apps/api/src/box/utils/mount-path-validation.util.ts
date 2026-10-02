/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { BoxMount } from '../dto/box-mount.dto'
import { mountPathError } from './volume-mount-path-validation.util'

/**
 * Validates the targets of typed mounts with the volume mount path rules,
 * reported under the mount's own field name.
 * @param mounts - Array of BoxMount objects to validate
 * @throws Error listing every invalid target
 */
export function validateMountTargets(mounts: BoxMount[]): void {
  const errors = mounts
    .map((mount) => mountPathError(mount.target, 'mount target'))
    .filter((error): error is string => error !== undefined)

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

/**
 * Validates the prefixes of typed mounts as safe S3 key prefixes.
 * @param mounts - Array of BoxMount objects to validate
 * @throws Error listing every invalid prefix
 */
export function validateMountSubPaths(mounts: BoxMount[]): void {
  // CLI(TODO): mirror the three key rules, and each parenthetical reason
  // verbatim, in src/cli/src/mountspec.rs (validate_mount_sub_path) so a bad
  // prefix fails before a request is built. Once it does, change one and the
  // other has to follow, or the CLI starts accepting prefixes this rejects.
  const errors: string[] = []

  for (const mount of mounts) {
    const subPath = mount.subPath

    // Omitted means the whole volume.
    if (subPath === undefined) {
      continue
    }

    if (typeof subPath !== 'string') {
      errors.push(`Invalid sub_path ${subPath} (must be a string)`)
      continue
    }

    // Unlike a volume's `subpath`, an empty string is not a second way to ask
    // for the whole volume; the REST create-box DTO refuses it too.
    // Client(TODO): refuse it in the Rust client too.
    if (subPath === '') {
      errors.push('Invalid sub_path "" (omit sub_path to mount the whole volume)')
      continue
    }

    // S3 keys should not start with /
    if (subPath.startsWith('/')) {
      errors.push(`Invalid sub_path "${subPath}" (S3 key prefixes cannot start with /)`)
      continue
    }

    // Prevent path traversal
    if (subPath.includes('..')) {
      errors.push(`Invalid sub_path "${subPath}" (cannot contain .. for security)`)
      continue
    }

    // No consecutive slashes
    if (subPath.includes('//')) {
      errors.push(`Invalid sub_path "${subPath}" (cannot contain consecutive slashes)`)
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume } from '../dto/box.dto'

/**
 * Validates mount paths for box volumes to ensure they are safe and valid.
 *
 * Backend-agnostic by construction: every volume reference carries mountPath
 * at the top level (managed volumes and filestore volumes alike), so this
 * needs no per-backend branch and filestore volumes get the same rules for
 * free.
 *
 * @param volumes - Array of BoxVolume objects to validate
 * @throws Error with descriptive message if any mount path is invalid
 */
export function validateMountPaths(volumes: BoxVolume[]): void {
  const errors: string[] = []

  for (const volume of volumes) {
    const value = volume.mountPath

    if (typeof value !== 'string') {
      errors.push(`Invalid mount path ${value} (must be a string)`)
      continue
    }

    if (!value.startsWith('/')) {
      errors.push(`Invalid mount path ${value} (must be absolute)`)
      continue
    }

    if (value === '/' || value === '//') {
      errors.push(`Invalid mount path ${value} (cannot mount to the root directory)`)
      continue
    }

    if (value.includes('/../') || value.includes('/./') || value.endsWith('/..') || value.endsWith('/.')) {
      errors.push(`Invalid mount path ${value} (cannot contain relative path components)`)
      continue
    }

    if (/\/\/+/.test(value.slice(1))) {
      errors.push(`Invalid mount path ${value} (cannot contain consecutive slashes)`)
      continue
    }

    const invalidPaths = ['/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/lib', '/lib64']
    const matchedInvalid = invalidPaths.find((invalid) => value === invalid || value.startsWith(invalid + '/'))
    if (matchedInvalid) {
      errors.push(`Invalid mount path ${value} (cannot mount to system directory)`)
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

/**
 * Rejects exactly one complete ".." component while allowing ordinary names
 * such as "foo..bar". Kept as a separate helper so the rule is explicit at the
 * security boundary instead of hidden behind a substring check.
 */
export function containsPathTraversalComponent(subpath: string): boolean {
  return subpath.split('/').some((component) => component === '..')
}

/**
 * Validates relative cloud-volume subpaths and their mount options
 * @param volumes - Array of BoxVolume objects to validate
 * @throws Error with descriptive message if any subpath is invalid
 */
export function validateSubpaths(volumes: BoxVolume[]): void {
  const errors: string[] = []

  for (const volume of volumes) {
    // A single trailing slash was accepted and effectively ignored by the
    // original path join. Trim only that legacy spelling; "//" remains invalid
    // because it was never equivalent to one empty component.
    if (
      typeof volume.subpath === 'string' &&
      volume.subpath !== '' &&
      !volume.subpath.startsWith('/') &&
      volume.subpath.endsWith('/') &&
      !volume.subpath.endsWith('//')
    ) {
      volume.subpath = volume.subpath.slice(0, -1)
    }

    if (volume.readOnly !== undefined && typeof volume.readOnly !== 'boolean') {
      errors.push('Invalid readOnly (must be a boolean)')
    }

    const subpath = volume.subpath

    // Empty/undefined subpath is valid (means mount entire volume)
    if (subpath === undefined) {
      continue
    }

    if (typeof subpath !== 'string') {
      errors.push(`VOLUME_SUBPATH_INVALID: invalid subpath ${subpath} (must be a string)`)
      continue
    }

    // Cloud-native requests use the empty string for a whole-volume mount,
    // matching the pre-existing behavior. REST `mounts` rejects it at its DTO
    // boundary before reaching this internal validator.
    if (subpath === '') {
      continue
    }

    if (subpath.includes('\0')) {
      errors.push(`VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (cannot contain NUL)`)
      continue
    }

    if (subpath.startsWith('/') || subpath.endsWith('/')) {
      errors.push(
        `VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (must be a relative directory path without a trailing slash)`,
      )
      continue
    }

    if (Buffer.byteLength(subpath, 'utf8') > 4096) {
      errors.push(`VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (must be at most 4096 bytes)`)
      continue
    }

    if (subpath.split('/').length > 64) {
      errors.push(`VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (must contain at most 64 path components)`)
      continue
    }

    let componentError = false
    for (const component of subpath.split('/')) {
      if (component === '' || component === '.' || containsPathTraversalComponent(component)) {
        errors.push(
          `VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (cannot contain empty, ".", or ".." path components)`,
        )
        componentError = true
        break
      }
      if (Buffer.byteLength(component, 'utf8') > 255) {
        errors.push(
          `VOLUME_SUBPATH_INVALID: invalid subpath "${subpath}" (each path component must be at most 255 bytes)`,
        )
        componentError = true
        break
      }
    }
    if (componentError) {
      continue
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

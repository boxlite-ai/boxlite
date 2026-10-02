/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxVolume } from '../dto/box.dto'

/** Box directories no mount may cover. */
const SYSTEM_DIRECTORIES = ['/proc', '/sys', '/dev', '/boot', '/etc', '/bin', '/sbin', '/lib', '/lib64']

/**
 * Checks one box-side mount path. `label` names the path in the message, so
 * every caller of these rules reports under its own field name.
 * @returns why the path is invalid, or undefined when it is valid
 */
export function mountPathError(path: unknown, label: string): string | undefined {
  if (typeof path !== 'string') {
    return `Invalid ${label} ${path} (must be a string)`
  }

  if (!path.startsWith('/')) {
    return `Invalid ${label} ${path} (must be absolute)`
  }

  if (path === '/' || path === '//') {
    return `Invalid ${label} ${path} (cannot mount to the root directory)`
  }

  if (path.includes('/../') || path.includes('/./') || path.endsWith('/..') || path.endsWith('/.')) {
    return `Invalid ${label} ${path} (cannot contain relative path components)`
  }

  if (/\/\/+/.test(path.slice(1))) {
    return `Invalid ${label} ${path} (cannot contain consecutive slashes)`
  }

  if (SYSTEM_DIRECTORIES.some((directory) => path === directory || path.startsWith(directory + '/'))) {
    return `Invalid ${label} ${path} (cannot mount to system directory)`
  }

  return undefined
}

/**
 * Validates mount paths for box volumes to ensure they are safe and valid
 * @param volumes - Array of BoxVolume objects to validate
 * @throws Error with descriptive message if any mount path is invalid
 */
export function validateMountPaths(volumes: BoxVolume[]): void {
  const errors = volumes
    .map((volume) => mountPathError(volume.mountPath, 'mount path'))
    .filter((error): error is string => error !== undefined)

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

/**
 * Validates that each volume's readOnly flag is omitted or a boolean; the
 * runner decodes it as a Go bool and would fail after the create was accepted.
 * A null counts as omitted: the runner's decode leaves the flag unset for it.
 * @param volumes - Array of BoxVolume objects to validate
 * @throws Error naming each volume whose readOnly is not a boolean
 */
export function validateReadOnlyFlags(volumes: BoxVolume[]): void {
  const errors = volumes
    .filter((volume) => volume.readOnly != null && typeof volume.readOnly !== 'boolean')
    .map(
      (volume) =>
        `Invalid readOnly ${JSON.stringify(volume.readOnly)} for volume ${volume.volumeId} (must be a boolean)`,
    )

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

/**
 * Validates subpaths for box volumes to ensure they are safe S3 key prefixes
 * @param volumes - Array of BoxVolume objects to validate
 * @throws Error with descriptive message if any subpath is invalid
 */
export function validateSubpaths(volumes: BoxVolume[]): void {
  const errors: string[] = []

  for (const volume of volumes) {
    const subpath = volume.subpath

    // Empty/undefined subpath is valid (means mount entire volume)
    if (!subpath) {
      continue
    }

    if (typeof subpath !== 'string') {
      errors.push(`Invalid subpath ${subpath} (must be a string)`)
      continue
    }

    // S3 keys should not start with /
    if (subpath.startsWith('/')) {
      errors.push(`Invalid subpath "${subpath}" (S3 key prefixes cannot start with /)`)
      continue
    }

    // Prevent path traversal
    if (subpath.includes('..')) {
      errors.push(`Invalid subpath "${subpath}" (cannot contain .. for security)`)
      continue
    }

    // No consecutive slashes
    if (subpath.includes('//')) {
      errors.push(`Invalid subpath "${subpath}" (cannot contain consecutive slashes)`)
      continue
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(', '))
  }
}

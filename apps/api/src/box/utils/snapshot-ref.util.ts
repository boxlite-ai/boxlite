/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

const BOXLITE_INTERNAL_REF_PATTERN = /(?:^|\/)boxlite-[a-f0-9]{64}:boxlite$/i

export function isBoxLiteInternalSnapshotRef(ref?: string): boolean {
  return !!ref && BOXLITE_INTERNAL_REF_PATTERN.test(ref)
}

export function normalizeSnapshotDigest(hash: string): string {
  const digest = hash?.trim().replace(/^sha256:/, '')

  if (!digest) {
    throw new Error('Snapshot digest is empty')
  }

  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`Invalid snapshot digest: ${hash}`)
  }

  return digest.toLowerCase()
}

export function createBoxLiteInternalSnapshotRef(
  registryUrl: string,
  project: string | undefined,
  hash: string,
): string {
  const sanitizedUrl = registryUrl.replace(/^https?:\/\//, '')
  const digest = normalizeSnapshotDigest(hash)

  return `${sanitizedUrl}/${project || 'boxlite'}/boxlite-${digest}:boxlite`
}

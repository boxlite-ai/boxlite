/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

const BOXLITE_INTERNAL_REF_PATTERN = /(?:^|\/)boxlite-[a-f0-9]{64}:boxlite$/i

export function isBoxLiteInternalArtifactRef(ref?: string): boolean {
  return !!ref && BOXLITE_INTERNAL_REF_PATTERN.test(ref)
}

export function normalizeArtifactDigest(hash: string): string {
  const digest = hash?.trim().replace(/^sha256:/, '')

  if (!digest) {
    throw new Error('Artifact digest is empty')
  }

  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`Invalid artifact digest: ${hash}`)
  }

  return digest.toLowerCase()
}

export function createBoxLiteInternalArtifactRef(
  registryUrl: string,
  project: string | undefined,
  hash: string,
): string {
  const sanitizedUrl = registryUrl.replace(/^https?:\/\//, '')
  const digest = normalizeArtifactDigest(hash)

  return `${sanitizedUrl}/${project || 'boxlite'}/boxlite-${digest}:boxlite`
}

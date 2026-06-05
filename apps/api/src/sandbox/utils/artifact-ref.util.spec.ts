/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  createBoxLiteInternalArtifactRef,
  isBoxLiteInternalArtifactRef,
  normalizeArtifactDigest,
} from './artifact-ref.util'

const DIGEST = 'a'.repeat(64)

describe('artifact-ref.util', () => {
  describe('isBoxLiteInternalArtifactRef', () => {
    it('matches generated BoxLite internal refs', () => {
      expect(isBoxLiteInternalArtifactRef(`registry.local/project/boxlite-${DIGEST}:boxlite`)).toBe(true)
      expect(isBoxLiteInternalArtifactRef(`boxlite-${DIGEST}:boxlite`)).toBe(true)
    })

    it('does not match normal external image refs', () => {
      expect(isBoxLiteInternalArtifactRef('alpine:3.22.4')).toBe(false)
      expect(isBoxLiteInternalArtifactRef('ghcr.io/example/app:1.0.0')).toBe(false)
    })
  })

  describe('normalizeArtifactDigest', () => {
    it('accepts sha256-prefixed digests', () => {
      expect(normalizeArtifactDigest(`sha256:${DIGEST.toUpperCase()}`)).toBe(DIGEST)
    })

    it('rejects empty digests', () => {
      expect(() => normalizeArtifactDigest('')).toThrow('Artifact digest is empty')
    })
  })

  describe('createBoxLiteInternalArtifactRef', () => {
    it('builds an internal ref from a valid digest', () => {
      expect(createBoxLiteInternalArtifactRef('https://registry.local', 'artifacts', DIGEST)).toBe(
        `registry.local/artifacts/boxlite-${DIGEST}:boxlite`,
      )
    })
  })
})

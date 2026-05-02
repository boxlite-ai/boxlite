/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  createBoxLiteInternalSnapshotRef,
  isBoxLiteInternalSnapshotRef,
  normalizeSnapshotDigest,
} from './snapshot-ref.util'

const DIGEST = 'a'.repeat(64)

describe('snapshot-ref.util', () => {
  describe('isBoxLiteInternalSnapshotRef', () => {
    it('matches generated BoxLite internal refs', () => {
      expect(isBoxLiteInternalSnapshotRef(`registry.local/project/boxlite-${DIGEST}:boxlite`)).toBe(true)
      expect(isBoxLiteInternalSnapshotRef(`boxlite-${DIGEST}:boxlite`)).toBe(true)
    })

    it('does not match normal external image refs', () => {
      expect(isBoxLiteInternalSnapshotRef('alpine:3.22.4')).toBe(false)
      expect(isBoxLiteInternalSnapshotRef('ghcr.io/example/app:1.0.0')).toBe(false)
    })
  })

  describe('normalizeSnapshotDigest', () => {
    it('accepts sha256-prefixed digests', () => {
      expect(normalizeSnapshotDigest(`sha256:${DIGEST.toUpperCase()}`)).toBe(DIGEST)
    })

    it('rejects empty digests', () => {
      expect(() => normalizeSnapshotDigest('')).toThrow('Snapshot digest is empty')
    })
  })

  describe('createBoxLiteInternalSnapshotRef', () => {
    it('builds an internal ref from a valid digest', () => {
      expect(createBoxLiteInternalSnapshotRef('https://registry.local', 'snapshots', DIGEST)).toBe(
        `registry.local/snapshots/boxlite-${DIGEST}:boxlite`,
      )
    })
  })
})

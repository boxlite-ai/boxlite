/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { CURATED_IMAGE_KEYS, resolveCuratedImageRef, validateCuratedImageKey } from './curated-images.constant'

describe('curated image allowlist', () => {
  const ENV_KEYS = ['BOXLITE_SYSTEM_BASE_IMAGE', 'BOXLITE_SYSTEM_PYTHON_IMAGE', 'BOXLITE_SYSTEM_NODE_IMAGE']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Isolate from the host env so the pinned fallback refs are deterministic.
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('exposes exactly the three curated keys', () => {
    expect(CURATED_IMAGE_KEYS).toEqual(['base', 'python', 'node'])
  })

  it('resolves each key to its private ghcr ref', () => {
    expect(resolveCuratedImageRef('base')).toContain('ghcr.io/boxlite-ai/boxlite-agent-base@sha256:')
    expect(resolveCuratedImageRef('python')).toContain('ghcr.io/boxlite-ai/boxlite-agent-python@sha256:')
    expect(resolveCuratedImageRef('node')).toContain('ghcr.io/boxlite-ai/boxlite-agent-node@sha256:')
  })

  it('defaults to base when no key is supplied', () => {
    expect(resolveCuratedImageRef(undefined)).toBe(resolveCuratedImageRef('base'))
  })

  it('prefers the env-configured ref over the pinned fallback', () => {
    process.env.BOXLITE_SYSTEM_PYTHON_IMAGE = 'ghcr.io/boxlite-ai/override@sha256:deadbeef'
    expect(resolveCuratedImageRef('python')).toBe('ghcr.io/boxlite-ai/override@sha256:deadbeef')
  })

  it('rejects any key outside the allowlist at the boundary (no arbitrary OCI ref)', () => {
    expect(() => resolveCuratedImageRef('alpine:3.23')).toThrow(BadRequestError)
    expect(() => resolveCuratedImageRef('ghcr.io/evil/image:latest')).toThrow(BadRequestError)
    expect(() => resolveCuratedImageRef('ubuntu')).toThrow(BadRequestError)
  })

  it('validates keys without resolving: returns the key itself, defaulting to base', () => {
    expect(validateCuratedImageKey('python')).toBe('python')
    expect(validateCuratedImageKey(undefined)).toBe('base')
    expect(() => validateCuratedImageKey('alpine:3.23')).toThrow(BadRequestError)
  })
})

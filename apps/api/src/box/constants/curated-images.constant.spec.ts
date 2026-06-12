/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { assertSupportedImage, supportedImages } from './curated-images.constant'

describe('supported image allowlist', () => {
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

  it('exposes the three pinned ghcr refs, base first (the default)', () => {
    const supported = supportedImages()
    expect(supported).toHaveLength(3)
    expect(supported[0]).toContain('ghcr.io/boxlite-ai/boxlite-agent-base@sha256:')
    expect(supported[1]).toContain('ghcr.io/boxlite-ai/boxlite-agent-python@sha256:')
    expect(supported[2]).toContain('ghcr.io/boxlite-ai/boxlite-agent-node@sha256:')
  })

  it('accepts each supported ref verbatim', () => {
    for (const ref of supportedImages()) {
      expect(assertSupportedImage(ref)).toBe(ref)
    }
  })

  it('defaults to the base ref when no image is supplied', () => {
    expect(assertSupportedImage(undefined)).toBe(supportedImages()[0])
  })

  it('prefers the env-configured ref over the pinned fallback', () => {
    process.env.BOXLITE_SYSTEM_PYTHON_IMAGE = 'ghcr.io/boxlite-ai/override@sha256:deadbeef'
    expect(assertSupportedImage('ghcr.io/boxlite-ai/override@sha256:deadbeef')).toBe(
      'ghcr.io/boxlite-ai/override@sha256:deadbeef',
    )
  })

  it('rejects anything outside the allowlist, naming the supported refs', () => {
    expect(() => assertSupportedImage('alpine:3.23')).toThrow(BadRequestError)
    expect(() => assertSupportedImage('ghcr.io/evil/image:latest')).toThrow(BadRequestError)
    // legacy curated keys are no longer accepted -- only full refs are
    expect(() => assertSupportedImage('python')).toThrow(BadRequestError)
    expect(() => assertSupportedImage('nope')).toThrow(/Supported images: .*boxlite-agent-base/)
  })
})

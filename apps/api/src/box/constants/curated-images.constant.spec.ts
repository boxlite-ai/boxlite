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
    const rotated = 'ghcr.io/boxlite-ai/boxlite-agent-python@sha256:' + 'a'.repeat(64)
    process.env.BOXLITE_SYSTEM_PYTHON_IMAGE = rotated
    expect(supportedImages()[1]).toBe(rotated)
  })

  it('rejects an unpinned override in the privileged namespace instead of trusting it', () => {
    // A tag (not a digest) on a ghcr.io/boxlite-ai ref would let the runner pull mutable
    // content with its privileged token -- such an override must be pinned or it is refused.
    process.env.BOXLITE_SYSTEM_BASE_IMAGE = 'ghcr.io/boxlite-ai/boxlite-agent-base:latest'
    expect(() => supportedImages()).toThrow(/BOXLITE_SYSTEM_BASE_IMAGE/)
  })

  it('passes overrides outside the privileged namespace through (e.g. the local dev registry)', () => {
    // dev:dex / e2e:local point these at localhost:5001 with a tag; that registry is outside
    // the runner's privileged ghcr token, so a tag there must not be rejected.
    const local = 'localhost:5001/boxlite/base:20260605-p0-r5-local'
    process.env.BOXLITE_SYSTEM_BASE_IMAGE = local
    expect(supportedImages()[0]).toBe(local)
  })

  it('rejects anything outside the allowlist, naming the supported refs', () => {
    expect(() => assertSupportedImage('alpine:3.23')).toThrow(BadRequestError)
    expect(() => assertSupportedImage('ghcr.io/evil/image:latest')).toThrow(BadRequestError)
    // legacy curated keys are no longer accepted -- only full refs are
    expect(() => assertSupportedImage('python')).toThrow(BadRequestError)
    expect(() => assertSupportedImage('nope')).toThrow(/Supported images: .*boxlite-agent-base/)
  })
})

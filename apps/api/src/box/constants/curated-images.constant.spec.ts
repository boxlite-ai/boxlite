/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { assertSupportedImage, supportedImages } from './curated-images.constant'

const BASE_REF = 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'
const PYTHON_REF = 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3'
const NODE_REF = 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3'

describe('supported image allowlist', () => {
  const ENV_KEYS = [
    'BOXLITE_SYSTEM_BASE_IMAGE',
    'BOXLITE_SYSTEM_PYTHON_IMAGE',
    'BOXLITE_SYSTEM_NODE_IMAGE',
    'BOXLITE_SYSTEM_IMAGES',
  ]
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

  it('exposes the three built-ins as name/ref pairs, base first (the default)', () => {
    expect(supportedImages()).toEqual([
      { name: 'base', ref: BASE_REF },
      { name: 'python', ref: PYTHON_REF },
      { name: 'node', ref: NODE_REF },
    ])
  })

  it('resolves a built-in name to its ref', () => {
    expect(assertSupportedImage('base')).toBe(BASE_REF)
    expect(assertSupportedImage('python')).toBe(PYTHON_REF)
    expect(assertSupportedImage('node')).toBe(NODE_REF)
  })

  it('accepts a full ref verbatim and returns it', () => {
    for (const { ref } of supportedImages()) {
      expect(assertSupportedImage(ref)).toBe(ref)
    }
  })

  it('defaults to the base ref when no image is supplied', () => {
    expect(assertSupportedImage(undefined)).toBe(BASE_REF)
  })

  it('prefers the env-configured ref over the curated fallback', () => {
    process.env.BOXLITE_SYSTEM_PYTHON_IMAGE = 'ghcr.io/boxlite-ai/override@sha256:deadbeef'
    expect(assertSupportedImage('python')).toBe('ghcr.io/boxlite-ai/override@sha256:deadbeef')
  })

  it('appends BOXLITE_SYSTEM_IMAGES additions, resolvable by name or ref', () => {
    process.env.BOXLITE_SYSTEM_IMAGES = 'hermes=sam2026go/hermes-agent:boxlite'

    expect(supportedImages()).toEqual([
      { name: 'base', ref: BASE_REF },
      { name: 'python', ref: PYTHON_REF },
      { name: 'node', ref: NODE_REF },
      { name: 'hermes', ref: 'sam2026go/hermes-agent:boxlite' },
    ])
    expect(assertSupportedImage('hermes')).toBe('sam2026go/hermes-agent:boxlite')
    expect(assertSupportedImage('sam2026go/hermes-agent:boxlite')).toBe('sam2026go/hermes-agent:boxlite')
  })

  it('parses a multi-entry list, trimming whitespace and dropping empty entries', () => {
    process.env.BOXLITE_SYSTEM_IMAGES = ' hermes = sam2026go/hermes-agent:boxlite , , foo=ghcr.io/acme/foo:1 '
    expect(supportedImages().slice(3)).toEqual([
      { name: 'hermes', ref: 'sam2026go/hermes-agent:boxlite' },
      { name: 'foo', ref: 'ghcr.io/acme/foo:1' },
    ])
  })

  it('throws on a malformed BOXLITE_SYSTEM_IMAGES entry (missing name or ref)', () => {
    process.env.BOXLITE_SYSTEM_IMAGES = 'sam2026go/hermes-agent:boxlite'
    expect(() => supportedImages()).toThrow(/Invalid BOXLITE_SYSTEM_IMAGES entry/)

    process.env.BOXLITE_SYSTEM_IMAGES = 'hermes='
    expect(() => supportedImages()).toThrow(/Invalid BOXLITE_SYSTEM_IMAGES entry/)
  })

  it('rejects a selector outside the set, naming the supported names and refs', () => {
    expect(() => assertSupportedImage('alpine:3.23')).toThrow(BadRequestError)
    expect(() => assertSupportedImage('ghcr.io/evil/image:latest')).toThrow(BadRequestError)
    // an added image is unreachable once its env entry is gone
    expect(() => assertSupportedImage('hermes')).toThrow(/Supported images: base \(.*boxlite-agent-base/)
  })
})

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'

/**
 * Curated-image gate: boxes may only boot from a fixed, operator-controlled set of images,
 * because the runner pulls with its own private-registry token and must never be handed an
 * arbitrary user-supplied image. The gate is deliberately thin and sits only at the request
 * boundary (BoxService create / warm-pool); everything downstream treats the resolved ref as
 * an opaque OCI ref. When per-org custom images land, delete this file and its call sites --
 * no other layer knows the curated set exists.
 *
 * Each image has a short `name` and an OCI `ref`; a caller may select either (undefined picks
 * the default -- the first entry, `base`). The set is the three built-ins plus any operator
 * additions, both configured via env so refs rotate and images are added without a code deploy:
 *   BOXLITE_SYSTEM_{BASE,PYTHON,NODE}_IMAGE  -- rotate a built-in's ref
 *   BOXLITE_SYSTEM_IMAGES                     -- add images, comma-separated `name=ref`
 *                                                e.g. "hermes=sam2026go/hermes-agent:boxlite"
 */
export type SupportedImage = {
  name: string
  ref: string
}

type BuiltinImageSource = {
  name: string
  envVar: string
  fallbackRef: string
}

const BUILTIN_IMAGE_SOURCES: BuiltinImageSource[] = [
  {
    name: 'base',
    envVar: 'BOXLITE_SYSTEM_BASE_IMAGE',
    fallbackRef: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3',
  },
  {
    name: 'python',
    envVar: 'BOXLITE_SYSTEM_PYTHON_IMAGE',
    fallbackRef: 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3',
  },
  {
    name: 'node',
    envVar: 'BOXLITE_SYSTEM_NODE_IMAGE',
    fallbackRef: 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3',
  },
]

/** Env var carrying operator-added images as comma-separated `name=ref` pairs. */
const EXTRA_IMAGES_ENV = 'BOXLITE_SYSTEM_IMAGES'

/**
 * Parse `name=ref,name=ref` into images. A malformed entry throws (operator config, not user
 * input) so a typo surfaces loudly at the boundary instead of silently dropping an image.
 */
function parseExtraImages(raw: string | undefined): SupportedImage[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=')
      const name = separator > 0 ? entry.slice(0, separator).trim() : ''
      const ref = separator > 0 ? entry.slice(separator + 1).trim() : ''
      if (!name || !ref) {
        throw new Error(`Invalid ${EXTRA_IMAGES_ENV} entry '${entry}', expected 'name=ref'`)
      }
      return { name, ref }
    })
}

/**
 * Curated images a box may boot from: the built-in three (each ref env-overridable) followed
 * by any BOXLITE_SYSTEM_IMAGES additions. The first entry (`base`) is the default image.
 */
export function supportedImages(): SupportedImage[] {
  const builtins = BUILTIN_IMAGE_SOURCES.map(({ name, envVar, fallbackRef }) => ({
    name,
    ref: process.env[envVar] || fallbackRef,
  }))
  return [...builtins, ...parseExtraImages(process.env[EXTRA_IMAGES_ENV])]
}

/**
 * Resolve a user-supplied selector to its OCI ref at the request boundary. Undefined selects
 * the default image; a value matching a supported name or ref resolves to that ref; anything
 * else is rejected with the full list so callers can self-correct.
 */
export function assertSupportedImage(image: string | undefined): string {
  const supported = supportedImages()

  if (image === undefined) {
    return supported[0].ref
  }
  const match = supported.find(({ name, ref }) => image === name || image === ref)
  if (!match) {
    const options = supported.map(({ name, ref }) => `${name} (${ref})`).join(', ')
    throw new BadRequestError(`Unsupported image '${image}'. Supported images: ${options}`)
  }
  return match.ref
}

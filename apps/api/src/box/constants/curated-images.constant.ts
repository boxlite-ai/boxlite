/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'

/**
 * Temporary curated-image gate: boxes may only boot from this fixed set of pinned OCI
 * refs, because the runner pulls with its own private-registry token and must never be
 * handed an arbitrary user-supplied image. The gate is deliberately thin and sits only
 * at the request boundary (BoxService create / warm-pool); everything downstream treats
 * `image` as an opaque OCI ref. When per-org custom images land, delete this file and
 * its call sites — no other layer knows the curated set exists.
 *
 * Env overrides (set on the Api service in apps/infra/sst.config.ts) allow digest
 * rotation without a code deploy; the fallbacks cover local/dev runs. An override in the
 * privileged ghcr.io/boxlite-ai namespace must be digest-pinned — a tag there would let
 * the runner pull mutable content with its GHCR token, silently widening the gate. Refs
 * to other registries (e.g. the localhost registry used by dev:dex / e2e:local) sit
 * outside that token and pass through.
 */
const SUPPORTED_IMAGE_SOURCES: Array<{ envVar: string; fallbackRef: string }> = [
  {
    envVar: 'BOXLITE_SYSTEM_BASE_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-base@sha256:834dcb65465985fc2f648451d76c81d166bc7672391c9064a0a115ce6306c85f',
  },
  {
    envVar: 'BOXLITE_SYSTEM_PYTHON_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-python@sha256:80d562a57f4bc12def4e54dbdb9e7d26d3268fe0767a2955ab5ad718041145d6',
  },
  {
    envVar: 'BOXLITE_SYSTEM_NODE_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-node@sha256:fcb8b840ab68567975853666c82fb6c59a3c1d14a0cdc31d7cbf3a01e6c6d247',
  },
]

/** The runner pulls images in this namespace with its privileged GHCR token. */
const PRIVILEGED_NAMESPACE = 'ghcr.io/boxlite-ai/'

/** A digest-pinned ref in the privileged namespace, e.g. `ghcr.io/boxlite-ai/x@sha256:<64-hex>`. */
const PINNED_GHCR_REF = /^ghcr\.io\/boxlite-ai\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/

/** Pinned OCI refs a box may boot from. The first entry is the default image. */
export function supportedImages(): string[] {
  return SUPPORTED_IMAGE_SOURCES.map(({ envVar, fallbackRef }) => {
    const ref = process.env[envVar]?.trim() || fallbackRef
    // A privileged-namespace ref must be digest-pinned: a tag there would let the runner
    // pull mutable content with its GHCR token. Refs to other registries (e.g. the
    // localhost registry used by dev:dex / e2e:local) are outside that token and pass through.
    if (ref.startsWith(PRIVILEGED_NAMESPACE) && !PINNED_GHCR_REF.test(ref)) {
      throw new Error(
        `${envVar} is in the privileged namespace and must be digest-pinned (${PRIVILEGED_NAMESPACE}<name>@sha256:<64-hex>), got '${ref}'`,
      )
    }
    return ref
  })
}

/**
 * Validate a user-supplied OCI ref at the request boundary. Undefined selects the
 * default image; anything outside the supported set is rejected with the full list so
 * callers can self-correct.
 */
export function assertSupportedImage(image: string | undefined): string {
  const supported = supportedImages()

  if (image === undefined) {
    return supported[0]
  }
  if (!supported.includes(image)) {
    throw new BadRequestError(`Unsupported image '${image}'. Supported images: ${supported.join(', ')}`)
  }
  return image
}

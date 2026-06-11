/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'

/**
 * Curated image keys are the only image identifiers a create request may supply.
 * They are opaque keys, NOT raw OCI refs: users cannot pass an arbitrary image.
 */
export type CuratedImageKey = 'base' | 'python' | 'node'

export const CURATED_IMAGE_KEYS: CuratedImageKey[] = ['base', 'python', 'node']

/**
 * Reserved box label that holds the resolved OCI ref between create and the start action.
 * Ephemeral storage in box.labels avoids a new entity column / migration.
 */
export const BOX_IMAGE_REF_LABEL = 'boxlite.io/image-ref'

const DEFAULT_CURATED_IMAGE_KEY: CuratedImageKey = 'base'

/**
 * Each curated key maps to an env var holding a sha256-pinned, private ghcr OCI ref.
 * These env vars are set on the Api service (apps/infra/sst.config.ts). The digests
 * below are fallbacks kept in sync with that config for local/dev runs where the env
 * is unset; the runner already authenticates to the private registry via its own token.
 */
const CURATED_IMAGE_ENV: Record<CuratedImageKey, { envVar: string; fallbackRef: string }> = {
  base: {
    envVar: 'BOXLITE_SYSTEM_BASE_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-base@sha256:834dcb65465985fc2f648451d76c81d166bc7672391c9064a0a115ce6306c85f',
  },
  python: {
    envVar: 'BOXLITE_SYSTEM_PYTHON_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-python@sha256:80d562a57f4bc12def4e54dbdb9e7d26d3268fe0767a2955ab5ad718041145d6',
  },
  node: {
    envVar: 'BOXLITE_SYSTEM_NODE_IMAGE',
    fallbackRef:
      'ghcr.io/boxlite-ai/boxlite-agent-node@sha256:fcb8b840ab68567975853666c82fb6c59a3c1d14a0cdc31d7cbf3a01e6c6d247',
  },
}

function isCuratedImageKey(key: string): key is CuratedImageKey {
  return (CURATED_IMAGE_KEYS as string[]).includes(key)
}

/**
 * Resolve a curated image key to its OCI ref. Undefined defaults to 'base'.
 * Rejects any key outside the curated allowlist at the request boundary.
 */
export function resolveCuratedImageRef(key: string | undefined): string {
  const resolvedKey = key ?? DEFAULT_CURATED_IMAGE_KEY

  if (!isCuratedImageKey(resolvedKey)) {
    throw new BadRequestError(`Invalid image '${resolvedKey}'. Allowed images: ${CURATED_IMAGE_KEYS.join(', ')}`)
  }

  const { envVar, fallbackRef } = CURATED_IMAGE_ENV[resolvedKey]
  return process.env[envVar] || fallbackRef
}

/**
 * Reverse-map a resolved OCI ref back to its curated key, so API responses echo the
 * opaque key the box was created with instead of the internal registry ref. Undefined
 * when the ref is not one of the currently-resolved curated refs (e.g. boxes created
 * before an env-var rotation).
 */
export function curatedImageKeyForRef(ref: string | undefined): CuratedImageKey | undefined {
  if (!ref) {
    return undefined
  }
  return CURATED_IMAGE_KEYS.find((key) => resolveCuratedImageRef(key) === ref)
}

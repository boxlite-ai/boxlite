/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Image } from '@boxlite-ai/api-client'

/**
 * The catalog name a box's image reference registers under: host and
 * repository, with no tag or digest. Mirrors the API's normalisation
 * (image-ref.util.ts): a bare Docker Hub name gains `docker.io/library/`.
 */
export function catalogNameOf(ref: string): string {
  let rest = ref.trim()
  const at = rest.indexOf('@')
  if (at >= 0) rest = rest.slice(0, at)
  const lastSlash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  if (colon > lastSlash) rest = rest.slice(0, colon)

  const firstSegment = rest.split('/')[0]
  const hasHost = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost'
  if (!hasHost) {
    return rest.includes('/') ? `docker.io/${rest}` : `docker.io/library/${rest}`
  }
  if (firstSegment === 'docker.io' && rest.split('/').length === 2) {
    return rest.replace('docker.io/', 'docker.io/library/')
  }
  return rest
}

/** The host of a reference, for routing a credential suggestion. */
export function registryHostOf(ref: string): string {
  return catalogNameOf(ref).split('/')[0]
}

/** The route segment for an image: its catalog id, or — for built-in rows, which have none — its name. */
export function imageRouteKey(image: Pick<Image, 'id' | 'name'>): string {
  return image.id ?? image.name
}

/**
 * The reference to start a box from: a built-in image's short name, which the
 * create API takes and the docs use; otherwise the first pinned tag, or the
 * bare name when none is pinned.
 */
export function imageStartRef(image: Pick<Image, 'name' | 'aliases' | 'curated'>): string {
  if (image.curated) return image.name
  return image.aliases.length > 0 ? `${image.name}:${image.aliases[0]}` : image.name
}

/** The box ids a removal conflict names, so they can be shown as boxes rather than ids. */
export function conflictBoxIds(message: string): string[] {
  const list = message.split(':').at(-1) ?? ''
  return list
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** OCI tag syntax, the rule the API applies to a pinned tag. */
export const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export function shortDigest(digest: string): string {
  return `${digest.slice(0, 19)}…`
}

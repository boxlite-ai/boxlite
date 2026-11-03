/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { ImageDetailDto } from '../../image/dto/image.dto'
import type { ImageReference } from '../../image/services/image-catalog.service'

export function toImageDetail(detail: ImageDetailDto) {
  return {
    name: detail.name,
    aliases: detail.aliases,
    curated: detail.curated,
    versions: detail.versions.map((version) => ({
      digest: version.digest,
      size_bytes: version.sizeBytes,
      source_ref: version.sourceRef,
      recorded_at: version.createdAt,
      aliases: version.aliases,
      last_used_at: version.lastUsedAt,
      upstream_missing_at: version.upstreamMissingAt,
    })),
    history: detail.history.map((event) => ({
      alias: event.aliasName,
      from_digest: event.fromDigest,
      to_digest: event.toDigest,
      actor: event.actorId,
      recorded_at: event.createdAt,
    })),
  }
}

export function toImageInfo(reference: ImageReference) {
  return {
    reference: reference.reference,
    repository: reference.name,
    tag: reference.tag,
    id: reference.digest,
    cached_at: reference.recordedAt.toISOString(),
    size_bytes: reference.sizeBytes,
  }
}

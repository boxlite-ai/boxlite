/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Snapshot } from '../sandbox/entities/snapshot.entity'

/**
 * Wire-compatible with the SDK's `ImageInfoListResponse` shape
 * (`src/boxlite/src/rest/images.rs::ImageInfoListResponse`). Field
 * names MUST stay in lockstep with the SDK — serde will drop any
 * mismatched fields silently.
 */
class ImageInfoDto {
  reference: string
  repository: string
  tag: string
  id: string
  cached_at: string
  size_bytes?: number
}

class ImageInfoListDto {
  images: ImageInfoDto[]
}

@ApiTags('BoxLite REST')
@Controller('v1/:prefix')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteImagesController {
  constructor(
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
  ) {}

  /**
   * `GET /v1/{prefix}/images` — list the images (snapshots, in
   * boxlite-runner terms) this org can build sandboxes from. Returns
   * the union of org-owned and `general=true` (cross-org) snapshots,
   * which is the same scoping the box-create path enforces.
   *
   * The SDK's `runtime.images.list()` deserialises onto this shape
   * (`ImageInfoListResponse` in `src/boxlite/src/rest/images.rs`).
   */
  @Get('images')
  async listImages(@AuthContext() ctx: OrganizationAuthContext): Promise<ImageInfoListDto> {
    const orgId = ctx.organizationId
    // Pull org-specific + general snapshots in one round trip.
    const rows = await this.snapshotRepository
      .createQueryBuilder('s')
      .where('s.organizationId = :orgId OR s.general = true', { orgId })
      .orderBy('s.createdAt', 'DESC')
      .getMany()

    return {
      images: rows.map((row) => {
        const reference = row.name ?? ''
        const [repository, tag] = splitRepoTag(reference)
        return {
          reference,
          repository,
          tag,
          id: row.id,
          cached_at: (row.createdAt ?? new Date()).toISOString(),
          // Snapshot entity may not always carry size; omit when unknown so
          // the SDK's optional field stays None.
          // Snapshot.size is stored in GB as a float; the SDK expects raw
          // bytes as u64. Round up to nearest byte and floor at 0.
          size_bytes:
            row.size != null && row.size > 0
              ? Math.max(0, Math.round(Number(row.size) * 1024 * 1024 * 1024))
              : undefined,
        }
      }),
    }
  }
}

function splitRepoTag(reference: string): [string, string] {
  if (!reference) return ['', '']
  // OCI references can carry a digest (`@sha256:…`); strip that off for
  // the "tag" view and keep the digest-free repo:tag breakdown.
  const noDigest = reference.split('@')[0]
  const colonIdx = noDigest.lastIndexOf(':')
  // No `:` — treat the whole thing as a repository with empty tag.
  if (colonIdx === -1) return [noDigest, '']
  return [noDigest.slice(0, colonIdx), noDigest.slice(colonIdx + 1)]
}

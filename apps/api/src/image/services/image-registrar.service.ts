/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageSourceKind } from '../enums/image-source-kind.enum'
import { isCuratedSelector, isSha256Digest, parseImageRef } from '../utils/image-ref.util'

/** What a runner reported about the image a box actually booted from. */
export type ReportedImage = {
  /** The registry's digest for the build that was pulled. */
  digest: string
  /** Declared on-registry size in bytes, as the manifest summed to. */
  sizeBytes: number
}

/**
 * Turns "a box started from this image" into the organization's catalog row.
 *
 * The catalog is written here and nowhere else, and only from a report: an
 * image is in it because it was successfully pulled and booted, so a ref that
 * does not exist upstream never leaves a row behind. That also makes this the
 * only place that learns a digest — the control plane never contacts a
 * registry itself.
 *
 * Every write is idempotent. A report can arrive more than once for the same
 * box, and two boxes can report the same new ref at the same moment; both are
 * settled by unique constraints rather than by reading first, so there is no
 * window between the check and the insert.
 */
@Injectable()
export class ImageRegistrarService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Record what a box booted from.
   *
   * Curated images are skipped: they are the operator's, shared by every
   * organization, and putting them in a tenant's catalog would count them
   * against that tenant's limit and let one tenant delete what everyone uses.
   */
  async onBoxStarted(organizationId: string, imageRef: string, reported: ReportedImage): Promise<void> {
    if (isCuratedSelector(imageRef)) {
      return
    }

    // Refused here rather than by the column, which would take a short bad
    // digest without complaint. The reason is downstream: this value becomes a
    // `storageRef` a runner is expected to pull and a key the resolver matches
    // against, so a digest of any other shape is a row that can never be used
    // and a ref no registry answers. Refused on its own, too — the box is
    // running either way and its state still has to be recorded.
    if (!isSha256Digest(reported.digest)) {
      throw new Error(`Refusing to record image digest '${reported.digest}': not a sha256 digest`)
    }

    const { host, repository, tag, digest } = parseImageRef(imageRef)
    const name = `${host}/${repository}`

    await this.dataSource.transaction(async (manager) => {
      // `lastUsedAt` is what eviction and the usage view read, so the update
      // is the point of the upsert for an image that already exists.
      const image = await manager
        .createQueryBuilder()
        .insert()
        .into(Image)
        .values({ organizationId, name, lastUsedAt: new Date() })
        .orUpdate(['lastUsedAt'], ['organizationId', 'name'], {
          indexPredicate: '"deletedAt" IS NULL',
        })
        .returning(['id'])
        .execute()

      // Both branches of the upsert return the row, and a name held only by a
      // soft-deleted image does not conflict at all: the insert succeeds and
      // the organization gets a fresh active row. That is what the partial
      // index is for — deleting an image is how a tenant picks up a moved tag,
      // and using it again brings it back as a new entry.
      const imageId: string | undefined = image.raw?.[0]?.id
      if (!imageId) {
        throw new Error(`Image upsert for '${name}' returned no row`)
      }

      await manager
        .createQueryBuilder()
        .insert()
        .into(ImageVersion)
        .values({
          imageId,
          digest: reported.digest,
          sizeBytes: reported.sizeBytes,
          sourceKind: ImageSourceKind.PULL,
          sourceSpec: { sourceRef: imageRef },
          storageRef: `${name}@${reported.digest}`,
        })
        .orIgnore()
        .execute()

      // A ref the caller already pinned names no tag to record. Neither does a
      // bare repository: `latest` is what the lookup means by it, not something
      // the caller said, and writing it would claim knowledge of a tag nobody
      // mentioned.
      if (!tag || digest) {
        return
      }

      const version = await manager
        .createQueryBuilder(ImageVersion, 'version')
        .select('version.id', 'id')
        .where('version."imageId" = :imageId', { imageId })
        .andWhere('version.digest = :digest', { digest: reported.digest })
        .getRawOne<{ id: string }>()
      if (!version) {
        return
      }

      // `DO NOTHING`, not an update: a tag that already points somewhere stays
      // there. Following a moved tag would change what a box boots from with
      // nobody asking, and deleting the image is the documented way to pick up
      // a move.
      await manager
        .createQueryBuilder()
        .insert()
        .into(ImageTag)
        .values({ imageId, name: tag, versionId: version.id })
        .orIgnore()
        .execute()
    })
  }
}

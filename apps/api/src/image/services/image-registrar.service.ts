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
import { CuratedImagePinService } from './curated-image-pin.service'
import { IMPLICIT_TAG, isSha256Digest, parseImageRef } from '../utils/image-ref.util'

/** What a runner reported about the image a box actually booted from. */
export type ReportedImage = {
  /** The registry's digest for the build that was pulled. */
  digest: string
  /** Declared on-registry size in bytes, as the manifest summed to. */
  sizeBytes: number
}

/**
 * The image a box booted from, and whose it is.
 *
 * Ownership travels with the ref rather than being derived from it here. The
 * curated set is env-driven and an operator can rotate it, so asking "is this
 * curated?" now answers about the set as it is now, not the set the box was
 * created against — and the caller is the one holding the answer recorded when
 * the box was created.
 */
export type BootedImage = {
  /** The ref the box was dispatched with. */
  ref: string
  /** False for the operator's curated set, which no tenant catalog may hold. */
  isOrgOwned: boolean
  /** Where it booted, which is whose cache a curated pin describes. */
  runnerId?: string
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
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly curatedImagePins: CuratedImagePinService,
  ) {}

  /**
   * Record what a box booted from.
   *
   * Curated images stay out of the catalog: they are the operator's, shared by
   * every organization, and putting them in a tenant's catalog would count them
   * against that tenant's limit and let one tenant delete what everyone uses.
   * What is kept for them instead is the build this runner booted, so the next
   * curated box it is given reads its cache rather than asking the registry.
   *
   * Which it is comes from the box rather than from a fresh look at the curated
   * set, because that set moves: an operator who rotates a curated reference
   * would otherwise have every box still running the old one file an image into
   * its organization's catalog, against that organization's limit.
   */
  async onBoxStarted(organizationId: string, image: BootedImage, reported: ReportedImage): Promise<void> {
    // Refused here rather than by the column, which would take a short bad
    // digest without complaint. The reason is downstream: this value becomes a
    // `storageRef` or a pinned ref a runner is expected to pull, and a key the
    // resolver matches against, so a digest of any other shape is a row that
    // can never be used and a ref no registry answers. Refused on its own, too —
    // the box is running either way and its state still has to be recorded.
    if (!isSha256Digest(reported.digest)) {
      throw new Error(`Refusing to record image digest '${reported.digest}': not a sha256 digest`)
    }

    if (!image.isOrgOwned) {
      if (image.runnerId) {
        await this.curatedImagePins.remember(image.runnerId, image.ref, reported.digest)
      }
      return
    }
    const imageRef = image.ref

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
      // index is for — deleting an image is how a tenant will pick up a moved
      // tag, and using it again brings it back as a new entry. Nothing soft-
      // deletes a row yet; the index has to be right before something does, or
      // the first delete is also a migration.
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

      // A ref the caller already pinned names no tag to record — it is the
      // digest that identifies it. A bare repository does name one: the
      // registry served it by fetching `latest`, so that is the tag this box
      // booted from, and it has to be recorded under the same name the
      // resolver looks it up by or the reference never pins.
      const recordedTag = tag ?? IMPLICIT_TAG
      if (digest) {
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
      // nobody asking, and deleting the image is the intended way to pick up a
      // move, once the catalog API exposes one.
      await manager
        .createQueryBuilder()
        .insert()
        .into(ImageTag)
        .values({ imageId, name: recordedTag, versionId: version.id })
        .orIgnore()
        .execute()
    })
  }
}

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, IsNull, Repository } from 'typeorm'
import { supportedImages } from '../../box/constants/curated-images.constant'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Organization } from '../../organization/entities/organization.entity'
import { ImageDetailDto, ImageDto, ImageUsageDto, ImageVersionDto } from '../dto/image.dto'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { catalogNameOf, isCuratedSelector } from '../utils/image-ref.util'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The operator's images, which every organization sees and none of them owns. */
function curatedEntries(): ImageDto[] {
  return supportedImages().map(({ name, ref }) => ({
    name,
    id: null,
    curated: true,
    curatedRef: ref,
    tags: [],
    versionCount: 0,
    // Not zero: nothing here ever measured a curated image. Zero would read as
    // "it is empty" in a size column, which is a different claim.
    sizeBytes: null,
    lastUsedAt: null,
    createdAt: null,
  }))
}

/**
 * Reads and removes catalog entries.
 *
 * Two things share every query here. The first is that an image is soft
 * deleted: `deletedAt` is set and its versions and tags stay behind, because
 * the cascade only fires on a real delete. So every read joins back to `image`
 * and filters `deletedAt IS NULL` — miss it and a deleted image still counts
 * against usage and still answers by name. The second is that curated images
 * are not rows at all: they are env-driven operator configuration, unioned in
 * at read time so that rotating one needs no migration.
 */
@Injectable()
export class ImageCatalogService {
  constructor(
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
    @InjectRepository(ImageVersion)
    private readonly versionRepository: Repository<ImageVersion>,
    @InjectRepository(ImageTag)
    private readonly tagRepository: Repository<ImageTag>,
    @InjectRepository(Box)
    private readonly boxRepository: Repository<Box>,
  ) {}

  async list(organization: Organization): Promise<ImageDto[]> {
    const images = await this.imageRepository.find({
      where: { organizationId: organization.id, deletedAt: IsNull() },
      order: { lastUsedAt: { direction: 'DESC', nulls: 'LAST' }, name: 'ASC' },
    })

    const ids = images.map((image) => image.id)
    const [versions, tags] = await Promise.all([this.versionsByImage(ids), this.tagsByImage(ids)])

    // Curated first: they are what a new organization boots from, and the
    // default image is the first of them.
    return [
      ...curatedEntries(),
      ...images.map((image) => toDto(image, versions.get(image.id) ?? [], tags.get(image.id) ?? [])),
    ]
  }

  async get(organization: Organization, idOrRef: string): Promise<ImageDetailDto> {
    const curated = curatedEntries().find((entry) => entry.name === idOrRef || entry.curatedRef === idOrRef)
    if (curated) {
      return { ...curated, versions: [], history: [] }
    }

    const image = await this.findRow(organization, idOrRef)
    if (!image) {
      throw new NotFoundException(`Image '${idOrRef}' not found`)
    }

    const [versions, tags] = await Promise.all([this.versionsByImage([image.id]), this.tagsByImage([image.id])])
    const rows = versions.get(image.id) ?? []
    return {
      ...toDto(image, rows, tags.get(image.id) ?? []),
      versions: rows.map(toVersionDto),
      // S1 records no tag movement: a tag keeps the digest it first resolved
      // to, so there is no history to report. The field is here because its
      // absence and its emptiness mean different things to a caller.
      history: [],
    }
  }

  /**
   * Remove an image from the catalog.
   *
   * It removes the entry, not the bytes: whatever runners already cached stays
   * cached, and using the same reference again pulls it back as a new entry.
   * That is also what makes this the way to pick up a tag that moved upstream,
   * since a recorded tag keeps pointing at the digest it first resolved to.
   */
  async delete(organization: Organization, idOrRef: string): Promise<void> {
    if (isCuratedSelector(idOrRef)) {
      throw new BadRequestError(
        `Image '${idOrRef}' is provided by the operator and shared by every organization, so it cannot be removed from the catalog`,
      )
    }

    const image = await this.findRow(organization, idOrRef)
    if (!image) {
      // Also the second delete of the same image: the row is still there with
      // `deletedAt` set, and every read here skips it. Callers may treat this
      // as success.
      throw new NotFoundException(`Image '${idOrRef}' not found`)
    }

    await this.assertNoBoxUsing(organization, image)

    // Soft, so the name can be used again — the unique index is partial on
    // `deletedAt IS NULL` exactly so that it can.
    await this.imageRepository.update({ id: image.id }, { deletedAt: new Date() })
  }

  async usage(organization: Organization): Promise<ImageUsageDto> {
    const count = await this.imageRepository.count({
      where: { organizationId: organization.id, deletedAt: IsNull() },
    })

    const total = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .where('image."organizationId" = :organizationId', { organizationId: organization.id })
      // Soft-deleted images keep their versions, so this join is what stops a
      // deleted image from still being counted.
      .andWhere('image."deletedAt" IS NULL')
      .andWhere('version.state = :state', { state: ImageVersionState.READY })
      .select('COALESCE(SUM(version."sizeBytes"), 0)', 'knownBytes')
      .getRawOne<{ knownBytes: string }>()

    return {
      count,
      limit: organization.imageCountLimit,
      knownBytes: Number(total?.knownBytes ?? 0),
    }
  }

  /** A catalog row by id or by any reference that normalises to its name. */
  private async findRow(organization: Organization, idOrRef: string): Promise<Image | null> {
    if (UUID_PATTERN.test(idOrRef)) {
      return this.imageRepository.findOne({
        where: { id: idOrRef, organizationId: organization.id, deletedAt: IsNull() },
      })
    }

    const name = catalogNameOf(idOrRef)
    if (!name) {
      return null
    }
    return this.imageRepository.findOne({
      where: { name, organizationId: organization.id, deletedAt: IsNull() },
    })
  }

  /**
   * Refuse while a box could still boot from it.
   *
   * Compared by normalised name rather than in SQL, because `box.image` holds
   * what the caller typed: three spellings reach one catalog row, and one of
   * them (`acme/app` for `docker.io/acme/app`) is not even a prefix of it. The
   * candidate set is bounded — one organization's live boxes, minus the ones
   * known to have booted from the curated set.
   */
  private async assertNoBoxUsing(organization: Organization, image: Image): Promise<void> {
    const candidates = await this.boxRepository
      .createQueryBuilder('box')
      .where('box."organizationId" = :organizationId', { organizationId: organization.id })
      .andWhere('box."desiredState" != :destroyed', { destroyed: BoxDesiredState.DESTROYED })
      .andWhere('box.image IS NOT NULL')
      // Null means the row predates the column, which is not the same as false
      // — only a box recorded as curated can be ruled out without looking.
      .andWhere('box."imageIsOrgOwned" IS NOT FALSE')
      .select(['box.id', 'box.image'])
      .getMany()

    const inUse = candidates.filter((box) => catalogNameOf(box.image) === image.name)
    if (inUse.length === 0) {
      return
    }

    throw new ConflictException(
      `Image '${image.name}' cannot be removed while ${inUse.length} box(es) can still boot from it: ${inUse
        .map((box) => box.id)
        .join(', ')}`,
    )
  }

  private async versionsByImage(imageIds: string[]): Promise<Map<string, ImageVersion[]>> {
    const grouped = new Map<string, ImageVersion[]>()
    if (imageIds.length === 0) {
      return grouped
    }
    const versions = await this.versionRepository.find({
      where: { imageId: In(imageIds), state: ImageVersionState.READY },
      order: { createdAt: 'DESC' },
    })
    for (const version of versions) {
      const bucket = grouped.get(version.imageId)
      if (bucket) {
        bucket.push(version)
      } else {
        grouped.set(version.imageId, [version])
      }
    }
    return grouped
  }

  private async tagsByImage(imageIds: string[]): Promise<Map<string, string[]>> {
    const grouped = new Map<string, string[]>()
    if (imageIds.length === 0) {
      return grouped
    }
    const tags = await this.tagRepository.find({
      where: { imageId: In(imageIds) },
      order: { name: 'ASC' },
    })
    for (const tag of tags) {
      const bucket = grouped.get(tag.imageId)
      if (bucket) {
        bucket.push(tag.name)
      } else {
        grouped.set(tag.imageId, [tag.name])
      }
    }
    return grouped
  }
}

function toDto(image: Image, versions: ImageVersion[], tags: string[]): ImageDto {
  return {
    name: image.name,
    id: image.id,
    curated: false,
    curatedRef: null,
    tags,
    versionCount: versions.length,
    // Per version, so layers two versions share are counted twice. Deliberate:
    // nothing here knows which layers overlap, and a number that pretended to
    // would be wrong in the direction that matters.
    sizeBytes: versions.reduce((total, version) => total + version.sizeBytes, 0),
    lastUsedAt: image.lastUsedAt?.toISOString() ?? null,
    createdAt: image.createdAt.toISOString(),
  }
}

function toVersionDto(version: ImageVersion): ImageVersionDto {
  return {
    id: version.id,
    digest: version.digest,
    sizeBytes: version.sizeBytes,
    sourceRef: version.sourceSpec.sourceRef,
    createdAt: version.createdAt.toISOString(),
  }
}

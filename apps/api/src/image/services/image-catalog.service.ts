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
import {
  IMAGE_HISTORY_LIMIT,
  ImageDetailDto,
  ImageDto,
  ImageTagEventDto,
  ImageUsageDto,
  ImageVersionDto,
} from '../dto/image.dto'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageTagEvent } from '../entities/image-tag-event.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { assertTagName, catalogNameOf, isCuratedSelector } from '../utils/image-ref.util'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One reference the catalog holds: a tag, or a version no tag points at. */
export interface ImageReference {
  reference: string
  name: string
  tag: string
  digest: string
  sizeBytes: number
  recordedAt: Date
}

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
 * Reads catalog entries, moves their tags, and removes them.
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
    @InjectRepository(ImageTagEvent)
    private readonly tagEventRepository: Repository<ImageTagEvent>,
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

  /**
   * One row per reference the organization's catalog holds: each tag, at the
   * version it points to, then each version no tag points to, by its digest.
   *
   * The shape a local image cache lists in, so an SDK lists both the same
   * way. The curated set is not in it: it has no recorded build to name.
   */
  async listReferences(organization: Organization): Promise<ImageReference[]> {
    const images = await this.imageRepository.find({
      where: { organizationId: organization.id, deletedAt: IsNull() },
      order: { name: 'ASC' },
    })
    if (images.length === 0) {
      return []
    }
    const ids = images.map((image) => image.id)
    const [versions, tags] = await Promise.all([
      this.versionsByImage(ids),
      this.tagRepository.find({ where: { imageId: In(ids) }, order: { name: 'ASC' } }),
    ])

    const references: ImageReference[] = []
    for (const image of images) {
      const held = versions.get(image.id) ?? []
      const byId = new Map(held.map((version) => [version.id, version]))
      const tagged = new Set<string>()
      const row = (reference: string, tag: string, version: ImageVersion): ImageReference => ({
        reference,
        name: image.name,
        tag,
        digest: version.digest,
        sizeBytes: version.sizeBytes,
        recordedAt: version.createdAt,
      })
      for (const tag of tags.filter((candidate) => candidate.imageId === image.id)) {
        // Only ready versions are read, so a tag can point at one not listed.
        const version = byId.get(tag.versionId)
        if (version) {
          tagged.add(version.id)
          references.push(row(`${image.name}:${tag.name}`, tag.name, version))
        }
      }
      for (const version of held.filter((candidate) => !tagged.has(candidate.id))) {
        // `<none>` is what a local image cache lists an untagged build as.
        references.push(row(`${image.name}@${version.digest}`, '<none>', version))
      }
    }
    return references
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

    const [versions, tags, history] = await Promise.all([
      this.versionsByImage([image.id]),
      this.tagsByImage([image.id]),
      this.historyOf(image.id),
    ])
    const versionRows = versions.get(image.id) ?? []
    const tagRows = tags.get(image.id) ?? []
    return {
      ...toDto(image, versionRows, tagRows),
      versions: versionRows.map((version) =>
        toVersionDto(
          version,
          tagRows.filter((tag) => tag.versionId === version.id),
        ),
      ),
      history: history.map(toTagEventDto),
    }
  }

  /**
   * Point a tag at one of the image's versions, creating the tag if it does not
   * exist, and record where it pointed before.
   *
   * Only the catalog changes. A box already created holds the digest-pinned ref
   * it was resolved to, so nothing running moves with the tag; and the version
   * was pulled when it was recorded, so nothing is pulled either. What changes
   * is what the next box created with this tag boots.
   */
  async moveTag(
    organization: Organization,
    idOrRef: string,
    tagName: string,
    versionId: string,
    actorId: string | null,
  ): Promise<ImageDetailDto> {
    if (isCuratedSelector(idOrRef)) {
      throw new BadRequestError(
        `Image '${idOrRef}' is provided by the operator, who pins its reference, so it has no tags to move`,
      )
    }
    assertTagName(tagName)

    const image = await this.findRow(organization, idOrRef)
    if (!image) {
      throw new NotFoundException(`Image '${idOrRef}' not found`)
    }

    await this.tagRepository.manager.transaction(async (manager) => {
      const version = await manager.findOne(ImageVersion, { where: { id: versionId, imageId: image.id } })
      if (!version) {
        throw new BadRequestError(`Version '${versionId}' is not a version of image '${image.name}'`)
      }
      if (version.state !== ImageVersionState.READY) {
        throw new BadRequestError(
          `Version '${versionId}' of image '${image.name}' is ${version.state}; only a ready version can be tagged`,
        )
      }

      // A tag that does not exist yet is created here. Two moves racing to
      // create it are settled by the unique constraint: the loser waits for the
      // winner to commit and then moves the tag the winner created.
      const created = await manager
        .createQueryBuilder()
        .insert()
        .into(ImageTag)
        .values({ imageId: image.id, name: tagName, versionId })
        .orIgnore()
        .returning(['id'])
        .execute()
      if (created.raw.length > 0) {
        await manager.insert(ImageTagEvent, {
          imageId: image.id,
          tagName,
          fromVersionId: null,
          toVersionId: versionId,
          actorId,
        })
        return
      }

      // Locked, so the version a move records leaving is the one the tag held
      // when it moved: two concurrent moves record a chain rather than both
      // claiming the same starting point.
      const tag = await manager
        .createQueryBuilder(ImageTag, 'tag')
        .setLock('pessimistic_write')
        .where('tag."imageId" = :imageId', { imageId: image.id })
        .andWhere('tag.name = :name', { name: tagName })
        .getOneOrFail()
      if (tag.versionId === versionId) {
        // Already there: nothing moved, so there is nothing to record.
        return
      }

      await manager.update(ImageTag, { id: tag.id }, { versionId })
      await manager.insert(ImageTagEvent, {
        imageId: image.id,
        tagName,
        fromVersionId: tag.versionId,
        toVersionId: versionId,
        actorId,
      })
    })

    return this.get(organization, image.id)
  }

  /**
   * Remove an image from the catalog.
   *
   * It removes the entry, not the bytes: whatever runners already cached stays
   * cached, and using the same reference again pulls it back as a new entry.
   * A pull never moves a recorded tag, so this is how to pick up where a tag
   * points upstream now, rather than move it to a version already recorded.
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

  private async tagsByImage(imageIds: string[]): Promise<Map<string, ImageTag[]>> {
    const grouped = new Map<string, ImageTag[]>()
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
        bucket.push(tag)
      } else {
        grouped.set(tag.imageId, [tag])
      }
    }
    return grouped
  }

  /** The most recent tag events, newest first — the index serves this read backwards. */
  private historyOf(imageId: string): Promise<ImageTagEvent[]> {
    return this.tagEventRepository.find({
      where: { imageId },
      order: { createdAt: 'DESC' },
      take: IMAGE_HISTORY_LIMIT,
    })
  }
}

function toDto(image: Image, versions: ImageVersion[], tags: ImageTag[]): ImageDto {
  return {
    name: image.name,
    id: image.id,
    curated: false,
    curatedRef: null,
    tags: tags.map((tag) => tag.name),
    versionCount: versions.length,
    // Per version, so layers two versions share are counted twice. Deliberate:
    // nothing here knows which layers overlap, and a number that pretended to
    // would be wrong in the direction that matters.
    sizeBytes: versions.reduce((total, version) => total + version.sizeBytes, 0),
    lastUsedAt: image.lastUsedAt?.toISOString() ?? null,
    createdAt: image.createdAt.toISOString(),
  }
}

function toVersionDto(version: ImageVersion, tags: ImageTag[]): ImageVersionDto {
  return {
    id: version.id,
    digest: version.digest,
    sizeBytes: version.sizeBytes,
    sourceRef: version.sourceSpec.sourceRef,
    tags: tags.map((tag) => tag.name),
    lastUsedAt: version.lastUsedAt?.toISOString() ?? null,
    upstreamMissingAt: version.upstreamMissingAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  }
}

function toTagEventDto(event: ImageTagEvent): ImageTagEventDto {
  return {
    tagName: event.tagName,
    fromVersionId: event.fromVersionId,
    toVersionId: event.toVersionId,
    actorId: event.actorId,
    createdAt: event.createdAt.toISOString(),
  }
}

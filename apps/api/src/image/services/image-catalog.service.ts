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
  ImageAliasEventDto,
  ImageUsageDto,
  ImageVersionDto,
} from '../dto/image.dto'
import { Image } from '../entities/image.entity'
import { ImageAlias } from '../entities/image-alias.entity'
import { ImageAliasEvent } from '../entities/image-alias-event.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { assertAliasName, catalogNameOf, isCuratedSelector } from '../utils/image-ref.util'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The version a tag moves to. The console names it by its catalog id; the box
 * API, whose versions carry no id, by its digest, which is unique within an
 * image.
 */
export type VersionSelector = { versionId: string } | { digest: string }

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
    aliases: [],
    versionCount: 0,
    // Not zero: nothing here ever measured a curated image. Zero would read as
    // "it is empty" in a size column, which is a different claim.
    sizeBytes: null,
    lastUsedAt: null,
    createdAt: null,
  }))
}

/**
 * Reads catalog entries, creates and deletes aliases, and removes images.
 *
 * Two things share every query here. The first is that an image is soft
 * deleted: `deletedAt` is set and its versions and aliases stay behind, because
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
    @InjectRepository(ImageAlias)
    private readonly aliasRepository: Repository<ImageAlias>,
    @InjectRepository(ImageAliasEvent)
    private readonly aliasEventRepository: Repository<ImageAliasEvent>,
    @InjectRepository(Box)
    private readonly boxRepository: Repository<Box>,
  ) {}

  async list(organization: Organization): Promise<ImageDto[]> {
    const images = await this.imageRepository.find({
      where: { organizationId: organization.id, deletedAt: IsNull() },
      order: { lastUsedAt: { direction: 'DESC', nulls: 'LAST' }, name: 'ASC' },
    })

    const ids = images.map((image) => image.id)
    const [versions, aliases] = await Promise.all([this.versionsByImage(ids), this.aliasesByImage(ids)])

    // Curated first: they are what a new organization boots from, and the
    // default image is the first of them.
    return [
      ...curatedEntries(),
      ...images.map((image) => toDto(image, versions.get(image.id) ?? [], aliases.get(image.id) ?? [])),
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
    const [versions, aliases] = await Promise.all([
      this.versionsByImage(ids),
      this.aliasRepository.find({ where: { imageId: In(ids) }, order: { name: 'ASC' } }),
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
      for (const tag of aliases.filter((candidate) => candidate.imageId === image.id)) {
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

    const [versions, aliases, history] = await Promise.all([
      this.versionsByImage([image.id]),
      this.aliasesByImage([image.id]),
      this.historyOf(image.id),
    ])
    const versionRows = versions.get(image.id) ?? []
    const aliasRows = aliases.get(image.id) ?? []
    return {
      ...toDto(image, versionRows, aliasRows),
      versions: versionRows.map((version) =>
        toVersionDto(
          version,
          aliasRows.filter((tag) => tag.versionId === version.id),
        ),
      ),
      history: history.map(toAliasEventDto),
    }
  }

  /**
   * Create a catalog alias for a ready version without replacing a binding.
   * The registry and existing boxes are unchanged; no image is pulled.
   */
  async createAlias(
    organization: Organization,
    idOrRef: string,
    aliasName: string,
    target: VersionSelector,
    actorId: string | null,
  ): Promise<ImageDetailDto> {
    if (isCuratedSelector(idOrRef)) {
      throw new BadRequestError(`Image '${idOrRef}' is provided by the operator, so its aliases cannot be changed`)
    }
    assertAliasName(aliasName)
    // TypeORM drops a where key whose value is undefined, so a selector that
    // names nothing would match whichever version of the image comes first.
    if (!('versionId' in target ? target.versionId : target.digest)) {
      throw new BadRequestError('An alias requires a version named by its id or its digest')
    }

    const image = await this.findRow(organization, idOrRef)
    if (!image) {
      throw new NotFoundException(`Image '${idOrRef}' not found`)
    }

    await this.aliasRepository.manager.transaction(async (manager) => {
      const where = 'versionId' in target ? { id: target.versionId } : { digest: target.digest }
      const named = 'versionId' in target ? `Version '${target.versionId}'` : `Digest '${target.digest}'`
      const version = await manager.findOne(ImageVersion, { where: { ...where, imageId: image.id } })
      if (!version) {
        throw new BadRequestError(`${named} is not a version of image '${image.name}'`)
      }
      if (version.state !== ImageVersionState.READY) {
        throw new BadRequestError(
          `${named} of image '${image.name}' is ${version.state}; an alias requires a ready version`,
        )
      }
      const versionId = version.id

      // The unique constraint also settles concurrent creates. A conflict
      // never becomes an update, even when both requests name the same digest.
      const created = await manager
        .createQueryBuilder()
        .insert()
        .into(ImageAlias)
        .values({ imageId: image.id, name: aliasName, versionId })
        .orIgnore()
        .returning(['id'])
        .execute()
      if (created.raw.length === 0) {
        throw new ConflictException({
          message: `Alias '${aliasName}' already exists for image '${image.name}'; delete it explicitly before creating it again`,
          code: 'already_exists',
        })
      }
      await manager.insert(ImageAliasEvent, {
        imageId: image.id,
        aliasName,
        fromVersionId: null,
        toVersionId: versionId,
        actorId,
      })
    })

    return this.get(organization, image.id)
  }

  /** Remove only the alias; versions, history and existing boxes remain. */
  async deleteAlias(organization: Organization, idOrRef: string, aliasName: string): Promise<void> {
    if (isCuratedSelector(idOrRef)) {
      throw new BadRequestError(`Image '${idOrRef}' is provided by the operator, so its aliases cannot be changed`)
    }
    assertAliasName(aliasName)
    const image = await this.findRow(organization, idOrRef)
    if (!image) {
      throw new NotFoundException(`Image '${idOrRef}' not found`)
    }
    const deleted = await this.aliasRepository.delete({ imageId: image.id, name: aliasName })
    if (deleted.affected === 0) {
      throw new NotFoundException(`Alias '${aliasName}' not found for image '${image.name}'`)
    }
  }

  /**
   * Remove an image from the catalog.
   *
   * It removes the entry, not the bytes: whatever runners already cached stays
   * cached, and using the same reference again pulls it back as a new entry.
   * A pull never replaces a catalog alias. Removing the entry lets a later
   * registry pull record fresh bindings.
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

  private async aliasesByImage(imageIds: string[]): Promise<Map<string, ImageAlias[]>> {
    const grouped = new Map<string, ImageAlias[]>()
    if (imageIds.length === 0) {
      return grouped
    }
    const aliases = await this.aliasRepository
      .createQueryBuilder('tag')
      .innerJoin('image_version', 'version', 'version.id = tag."versionId"')
      .where('tag."imageId" IN (:...imageIds)', { imageIds })
      .andWhere('version.state = :state', { state: ImageVersionState.READY })
      .orderBy('tag.name', 'ASC')
      .getMany()
    for (const tag of aliases) {
      const bucket = grouped.get(tag.imageId)
      if (bucket) {
        bucket.push(tag)
      } else {
        grouped.set(tag.imageId, [tag])
      }
    }
    return grouped
  }

  /**
   * The most recent tag events, newest first — the index serves this read
   * backwards — with the versions they name, so each event carries their
   * digests and reads without the image's version list.
   */
  private historyOf(imageId: string): Promise<ImageAliasEvent[]> {
    return this.aliasEventRepository.find({
      where: { imageId },
      relations: { fromVersion: true, toVersion: true },
      order: { createdAt: 'DESC' },
      take: IMAGE_HISTORY_LIMIT,
    })
  }
}

function toDto(image: Image, versions: ImageVersion[], aliases: ImageAlias[]): ImageDto {
  return {
    name: image.name,
    id: image.id,
    curated: false,
    curatedRef: null,
    aliases: aliases.map((tag) => tag.name),
    versionCount: versions.length,
    // Per version, so layers two versions share are counted twice. Deliberate:
    // nothing here knows which layers overlap, and a number that pretended to
    // would be wrong in the direction that matters.
    sizeBytes: versions.reduce((total, version) => total + version.sizeBytes, 0),
    lastUsedAt: image.lastUsedAt?.toISOString() ?? null,
    createdAt: image.createdAt.toISOString(),
  }
}

function toVersionDto(version: ImageVersion, aliases: ImageAlias[]): ImageVersionDto {
  return {
    id: version.id,
    digest: version.digest,
    sizeBytes: version.sizeBytes,
    sourceRef: version.sourceSpec.sourceRef,
    aliases: aliases.map((tag) => tag.name),
    lastUsedAt: version.lastUsedAt?.toISOString() ?? null,
    upstreamMissingAt: version.upstreamMissingAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  }
}

function toAliasEventDto(event: ImageAliasEvent): ImageAliasEventDto {
  return {
    aliasName: event.aliasName,
    fromVersionId: event.fromVersionId,
    fromDigest: event.fromVersion?.digest ?? null,
    toVersionId: event.toVersionId,
    toDigest: event.toVersion.digest,
    actorId: event.actorId,
    createdAt: event.createdAt.toISOString(),
  }
}

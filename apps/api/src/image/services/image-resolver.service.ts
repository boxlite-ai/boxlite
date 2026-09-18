/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { assertSupportedImage } from '../../box/constants/curated-images.constant'
import { Organization } from '../../organization/entities/organization.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { isCuratedSelector, isDigestPinned, parseImageRef } from '../utils/image-ref.util'

/** The tag a bare repository means. */
const IMPLICIT_TAG = 'latest'

/** What a box should boot from, and where that answer came from. */
export type ResolvedImage = {
  /** The ref handed to the runner. */
  ref: string
  /**
   * False only for the curated set, which every organization shares. A ref a
   * tenant named is org-owned whether or not the catalog knew it — a miss means
   * it has not been pulled yet, not that it belongs to everyone.
   */
  isOrgOwned: boolean
  /** The catalog row this resolved through, absent when nothing matched. */
  imageId?: string
}

/**
 * Turns what a caller asked for into the ref a runner is given.
 *
 * Four cases, and the first one is the whole point of the ordering: a curated
 * selector is answered from the curated set without touching the database, so
 * the path every existing caller takes stays exactly as expensive as it was.
 * The other three look the organization's catalog up, and a miss is not an
 * error — it means this image has not been pulled yet, and the unpinned ref is
 * passed through so the runner can pull it and report what it got.
 *
 * A hit must come back digest-pinned. That is the assertion at the bottom, and
 * it is load-bearing rather than defensive: a runner's own image cache is keyed
 * by the ref string it was handed and never re-checked, so a host that once
 * pulled `app:stable` keeps serving that build for as long as the row lives. A
 * hit that came back unpinned would make which build a box gets depend on which
 * runner it landed on.
 */
@Injectable()
export class ImageResolverService {
  constructor(
    @InjectRepository(ImageVersion)
    private readonly versionRepository: Repository<ImageVersion>,
  ) {}

  async resolve(organization: Organization, image: string | undefined): Promise<ResolvedImage> {
    if (isCuratedSelector(image)) {
      return { ref: assertSupportedImage(image), isOrgOwned: false }
    }

    const ref = image as string
    const { host, repository, tag, digest } = parseImageRef(ref)
    const name = `${host}/${repository}`

    const resolved = digest
      ? await this.resolveByDigest(organization, name, ref, digest)
      : await this.resolveByTag(organization, name, ref, tag ?? IMPLICIT_TAG)

    assertPinnedOnCatalogHit(resolved)
    return resolved
  }

  /**
   * A ref the caller already pinned. The lookup adds no pinning — it only says
   * whether the catalog knows this digest, which is what tells a later step
   * there is a row to touch.
   */
  private async resolveByDigest(
    organization: Organization,
    name: string,
    ref: string,
    digest: string,
  ): Promise<ResolvedImage> {
    const version = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .where('image."organizationId" = :organizationId', { organizationId: organization.id })
      .andWhere('image.name = :name', { name })
      // A soft-deleted image must not resolve, or deleting one would stop being
      // the way to pick up a tag that moved upstream.
      .andWhere('image."deletedAt" IS NULL')
      .andWhere('version.digest = :digest', { digest })
      .andWhere('version.state = :state', { state: ImageVersionState.READY })
      .select('version."imageId"', 'imageId')
      .getRawOne<{ imageId: string }>()

    return version ? { ref, isOrgOwned: true, imageId: version.imageId } : { ref, isOrgOwned: true }
  }

  /**
   * A tag, resolved to the digest it pointed at the first time it was pulled.
   * It is deliberately not re-checked against the registry: the tag may have
   * moved upstream, and following it would change what a box boots from without
   * anyone asking.
   */
  private async resolveByTag(
    organization: Organization,
    name: string,
    ref: string,
    tag: string,
  ): Promise<ResolvedImage> {
    const hit = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .innerJoin('image_tag', 'tag', 'tag."versionId" = version.id')
      .where('image."organizationId" = :organizationId', { organizationId: organization.id })
      .andWhere('image.name = :name', { name })
      .andWhere('image."deletedAt" IS NULL')
      .andWhere('tag.name = :tag', { tag })
      .andWhere('version.state = :state', { state: ImageVersionState.READY })
      .select('version.digest', 'digest')
      .addSelect('version."imageId"', 'imageId')
      .getRawOne<{ digest: string; imageId: string }>()

    if (!hit) {
      // The caller's own string, not a normalised one: a miss has nothing to
      // add, and rewriting `acme/app` into `docker.io/acme/app:latest` would
      // put this resolver's spelling in front of a runner that already has its
      // own. The two paths agree on that — neither touches a ref it did not
      // resolve.
      return { ref, isOrgOwned: true }
    }
    return { ref: `${name}@${hit.digest}`, isOrgOwned: true, imageId: hit.imageId }
  }
}

/**
 * A catalog hit has to be digest-pinned. A runner caches by the ref string it
 * was handed and does not re-check it, so an unpinned hit would leave which
 * build a box gets depending on which runner it landed on — a failure that is
 * silent everywhere else, which is why it is caught here.
 *
 * Not a `BadRequestError`: the caller did nothing wrong, the resolver did.
 */
export function assertPinnedOnCatalogHit(resolved: ResolvedImage): void {
  if (resolved.imageId && !isDigestPinned(resolved.ref)) {
    throw new InternalServerErrorException(`Resolved '${resolved.ref}' from the image catalog without pinning a digest`)
  }
}

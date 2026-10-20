/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { boxImageIsOrgOwned } from '../../box/utils/image-ownership.util'
import { ImageAlias } from '../entities/image-alias.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { parseImageRef, ParsedImageRef, upstreamRefOf } from '../utils/image-ref.util'
import { pullFailureOf } from '../utils/pull-failure.util'

/** The part of a box a failed pull is explained against. */
export type PulledBox = Pick<Box, 'organizationId' | 'image' | 'imageIsOrgOwned'>

/**
 * Turns a failed pull into a reason a tenant can act on.
 *
 * The control plane learns a registry no longer has a build only when a
 * runner without it in cache tries to pull it: runners that cached it start it
 * fine, so without this the same box succeeds or fails by where it lands. Two
 * things come of it. The box records a reason naming the upstream image and
 * what to do, in place of the runtime's words; and a build the catalog holds
 * is marked on its version, so the catalog says so before the next box finds
 * out.
 */
@Injectable()
export class ImagePullFailureService {
  private readonly logger = new Logger(ImagePullFailureService.name)

  constructor(
    @InjectRepository(ImageVersion)
    private readonly versionRepository: Repository<ImageVersion>,
    @InjectRepository(ImageAlias)
    private readonly tagRepository: Repository<ImageAlias>,
  ) {}

  /**
   * The reason to record for a box whose pull failed with `reason`.
   *
   * Anything the registry did not explain is returned as it came, as is a
   * failure of the operator's curated set, which is theirs to fix. So is a
   * refusal through the registry proxy: the proxy refuses on its own account
   * too — a runner key it does not accept, a runner that hosts no box of the
   * organization, an upstream host or address it will not reach — and its
   * words already say which it was. It never throws: its callers are
   * recording that a box failed, and that has to land even when the catalog
   * cannot be read.
   */
  async reasonFor(box: PulledBox, reason: string): Promise<string> {
    const failure = pullFailureOf(reason)
    if (!failure || !box.image || !boxImageIsOrgOwned(box)) {
      return reason
    }

    const ref = upstreamRefOf(box.image)
    const isThroughProxy = ref !== box.image
    let parsed: ParsedImageRef
    try {
      parsed = parseImageRef(ref)
    } catch {
      // Not a reference this can name; the runtime's words are better than a guess.
      return reason
    }
    const codes = failure.codes.join(', ')

    if (failure.kind === 'refused') {
      // A direct pull is one no registered login covers, or it would have gone
      // through the proxy; and a registry refuses a repository that does not
      // exist the same way it refuses a private one.
      return isThroughProxy
        ? reason
        : `Failed to pull image '${ref}': ${parsed.host} refused the pull (${codes}). The image is private or does not exist, and no registry login of the organization covers it.`
    }

    let aliases: string[] | undefined
    try {
      aliases = parsed.digest
        ? await this.markMissing(box.organizationId, `${parsed.host}/${parsed.repository}`, parsed.digest)
        : undefined
    } catch (error) {
      this.logger.warn(`Could not mark '${ref}' as gone upstream; recording the runtime's reason: ${error}`)
      return reason
    }
    if (aliases === undefined) {
      return `Failed to pull image '${ref}': ${parsed.host} has no such image (${codes}). Check the repository and the tag.`
    }
    const move =
      aliases.length === 0
        ? 'Use a version its registry still has'
        : `Move ${aliases.length === 1 ? 'the tag' : 'the aliases'} ${aliases.map((tag) => `'${tag}'`).join(', ')} to a version its registry still has`
    return `Failed to pull image '${ref}': ${parsed.host} no longer has it (${codes}). Boxes on runners that already hold it still start. ${move}, or remove the image from the catalog and use the reference again.`
  }

  /**
   * Mark the organization's version of this build as gone upstream, keeping
   * the first time it was found gone, and name the aliases that point at it.
   * Undefined when the catalog does not hold the build.
   */
  private async markMissing(organizationId: string, name: string, digest: string): Promise<string[] | undefined> {
    const version = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .where('image."organizationId" = :organizationId', { organizationId })
      .andWhere('image.name = :name', { name })
      .andWhere('image."deletedAt" IS NULL')
      .andWhere('version.digest = :digest', { digest })
      .select('version.id', 'id')
      .getRawOne<{ id: string }>()
    if (!version) {
      return undefined
    }

    // Only the mark: the row stays and so does its state. A runner that cached
    // the build still starts it, and a registry that answered wrongly once
    // must not cost anyone the version.
    await this.versionRepository
      .createQueryBuilder()
      .update(ImageVersion)
      .set({ upstreamMissingAt: () => 'COALESCE("upstreamMissingAt", now())' })
      .where('id = :id', { id: version.id })
      .execute()

    const aliases = await this.tagRepository.find({ where: { versionId: version.id }, order: { name: 'ASC' } })
    return aliases.map((tag) => tag.name)
  }
}

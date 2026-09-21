/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { reportedBoxState } from '../../box/utils/box-state.util'
import { boxImageIsOrgOwned } from '../../box/utils/image-ownership.util'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { catalogNameOf } from '../utils/image-ref.util'

/**
 * Whether a box in flight is waiting on its image being pulled for the first
 * time.
 *
 * Derived rather than measured. Nothing reports which part of a create is
 * taking the time, so this infers it from two facts that are already true: the
 * box has not started, and its image has no recorded version. The known limit
 * is that it cannot tell "still downloading" from "downloaded, still booting" —
 * a real phase needs the runner to say so, which is not in this round.
 *
 * Curated images are excluded, and not only because they are already cached
 * everywhere. Answering for them would mean a catalog query on the path every
 * existing caller takes, and that path is required to touch neither the catalog
 * nor a registry.
 */
@Injectable()
export class ImagePreparationService {
  constructor(
    @InjectRepository(ImageVersion)
    private readonly versionRepository: Repository<ImageVersion>,
  ) {}

  /**
   * The ids of the boxes among these that are waiting on a first pull.
   *
   * Takes the whole list so a listing costs one query rather than one per box,
   * and costs none at all when nothing is being created — which is the usual
   * case, and the reason this is safe to call from every box response.
   */
  async preparingImage(boxes: Box[]): Promise<Set<string>> {
    const preparing = new Set<string>()

    const byOrganization = new Map<string, Box[]>()
    for (const box of boxes) {
      if (reportedBoxState(box) !== BoxState.CREATING || !boxImageIsOrgOwned(box)) {
        continue
      }
      const waiting = byOrganization.get(box.organizationId)
      if (waiting) {
        waiting.push(box)
      } else {
        byOrganization.set(box.organizationId, [box])
      }
    }

    for (const [organizationId, waiting] of byOrganization) {
      const byName = new Map<string, Box[]>()
      for (const box of waiting) {
        const name = catalogNameOf(box.image)
        // A reference this service cannot normalise is one it cannot look up.
        // Reporting progress for it would be a claim about an image nothing
        // here can identify.
        if (!name) {
          continue
        }
        const sharing = byName.get(name)
        if (sharing) {
          sharing.push(box)
        } else {
          byName.set(name, [box])
        }
      }
      if (byName.size === 0) {
        continue
      }

      const ready = await this.readyNames(organizationId, [...byName.keys()])
      for (const [name, sharing] of byName) {
        if (ready.has(name)) {
          continue
        }
        for (const box of sharing) {
          preparing.add(box.id)
        }
      }
    }

    return preparing
  }

  /** Of these catalog names, the ones this organization already holds a pulled version of. */
  private async readyNames(organizationId: string, names: string[]): Promise<Set<string>> {
    const rows = await this.versionRepository
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .where('image."organizationId" = :organizationId', { organizationId })
      // A deleted image is gone from the catalog, so the next box using its
      // reference pulls again and is genuinely waiting.
      .andWhere('image."deletedAt" IS NULL')
      .andWhere('image.name IN (:...names)', { names })
      .andWhere('version.state = :state', { state: ImageVersionState.READY })
      .select('image.name', 'name')
      .distinct(true)
      .getRawMany<{ name: string }>()

    return new Set(rows.map((row) => row.name))
  }
}

/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { BoxService } from '../box/services/box.service'
import { BoxSnapshotService, SnapshotScope } from '../box/services/box-snapshot.service'
import { BoxSnapshotState } from '../box/enums/box-snapshot-state.enum'
import { Context } from '../common/context/context'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { SnapshotChildDto } from './dto/snapshot-child.dto'
import { boxToBoxResponse, createBoxToCreateBox } from './mappers/box-to-box.mapper'

/** Admission shared by the organization and source-box snapshot routes. */
@Injectable()
export class SnapshotBoxService {
  constructor(
    private readonly snapshots: BoxSnapshotService,
    private readonly boxes: BoxService,
    private readonly limits: CommerceBoxLimitService,
  ) {}

  async create(auth: OrganizationAuthContext, id: string, body: SnapshotChildDto, scope: SnapshotScope = {}) {
    if (!this.snapshots.isEnabled())
      throw new ServiceUnavailableException('Box snapshots are not configured on this server')
    const snapshot = await this.snapshots.findOne(auth.organizationId, id, scope)
    if (snapshot.state !== BoxSnapshotState.READY) throw new ConflictException('Only a ready snapshot can create a box')
    const options = body.options ?? {}
    if (
      options.volumes?.length &&
      !hasOrganizationResourcePermissions(auth, [Permission.READ_VOLUMES, Permission.WRITE_VOLUMES])
    ) {
      throw new ForbiddenException('Volume permissions required')
    }
    if (options.disk_size_gb !== undefined && options.disk_size_gb !== snapshot.diskGb) {
      throw new ConflictException(`Snapshot requires a ${snapshot.diskGb} GiB disk`)
    }
    const dto = createBoxToCreateBox(options, snapshot.region)
    dto.name = body.name?.trim() || undefined
    dto.disk = snapshot.diskGb
    const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(auth.organizationId)
    return boxToBoxResponse(
      await this.boxes.create(dto, auth.organization, Context.user(), {
        maxCreatedBoxes,
        initialSnapshotId: snapshot.id,
      }),
    )
  }
}

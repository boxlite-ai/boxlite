/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Audit } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { BoxSnapshotService } from '../box/services/box-snapshot.service'
import { SnapshotResponse, snapshotToResponse } from './mappers/snapshot.mapper'
import { SnapshotChildDto } from './dto/snapshot-child.dto'
import { SnapshotBoxService } from './snapshot-box.service'

/**
 * Every snapshot of the organization, including those whose source box is
 * gone — the only routes that still reach them once it is.
 */
// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/snapshots', 'v1/:prefix/snapshots'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
@ApiBearerAuth()
export class BoxliteSnapshotController {
  constructor(
    private readonly snapshotService: BoxSnapshotService,
    private readonly snapshotBoxes: SnapshotBoxService,
  ) {}

  @Post(':snapshot/boxes')
  @HttpCode(201)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.BOX, targetIdFromResult: (result) => result?.box_id })
  async createBoxFromAnySnapshot(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('snapshot') snapshot: string,
    @Body() body: SnapshotChildDto,
  ) {
    return this.snapshotBoxes.create(auth, snapshot, body)
  }

  @Get()
  async listAllSnapshots(
    @AuthContext() authContext: OrganizationAuthContext,
  ): Promise<{ snapshots: SnapshotResponse[] }> {
    const snapshots = await this.snapshotService.list(authContext.organizationId)
    return { snapshots: snapshots.map(snapshotToResponse) }
  }

  @Get(':snapshot')
  async getAnySnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('snapshot') snapshot: string,
  ): Promise<SnapshotResponse> {
    return snapshotToResponse(await this.snapshotService.findOne(authContext.organizationId, snapshot))
  }

  @Delete(':snapshot')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.SNAPSHOT,
    targetIdFromRequest: (req) => req.params.snapshot,
  })
  async removeAnySnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('snapshot') snapshot: string,
  ): Promise<void> {
    await this.snapshotService.remove(authContext.organizationId, snapshot)
  }
}

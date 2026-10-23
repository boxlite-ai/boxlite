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
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { BoxService } from '../box/services/box.service'
import { BoxSnapshotService, SnapshotScope } from '../box/services/box-snapshot.service'
import { CreateSnapshotDto } from './dto/create-snapshot.dto'
import {
  SnapshotResponse,
  SnapshotRestoreResponse,
  restoreToResponse,
  snapshotToResponse,
} from './mappers/snapshot.mapper'

/**
 * Snapshots seen from a box: the ones taken from it, and restores into it.
 *
 * Reads and deletes under a box only reach the snapshots taken from that box.
 * A restore names the box it writes to, and takes any ready snapshot of the
 * organization — the organization-wide routes live in BoxliteSnapshotController.
 */
// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
@ApiBearerAuth()
export class BoxliteBoxSnapshotController {
  constructor(
    private readonly boxService: BoxService,
    private readonly snapshotService: BoxSnapshotService,
  ) {}

  @Post(':boxId/snapshots')
  @HttpCode(201)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.SNAPSHOT,
    targetIdFromResult: (result: SnapshotResponse) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateSnapshotDto>) => ({ box: req.params.boxId, name: req.body?.name }),
    },
  })
  async createSnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Body() dto: CreateSnapshotDto,
  ): Promise<SnapshotResponse> {
    return snapshotToResponse(await this.snapshotService.create(boxId, dto.name, authContext.organizationId))
  }

  @Get(':boxId/snapshots')
  async listSnapshots(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
  ): Promise<{ snapshots: SnapshotResponse[] }> {
    const scope = await this.scopeOf(boxId, authContext)
    const snapshots = await this.snapshotService.list(authContext.organizationId, scope)
    return { snapshots: snapshots.map(snapshotToResponse) }
  }

  @Get(':boxId/snapshots/:snapshot')
  async getSnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('snapshot') snapshot: string,
  ): Promise<SnapshotResponse> {
    const scope = await this.scopeOf(boxId, authContext)
    return snapshotToResponse(await this.snapshotService.findOne(authContext.organizationId, snapshot, scope))
  }

  @Delete(':boxId/snapshots/:snapshot')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_BOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.SNAPSHOT,
    targetIdFromRequest: (req) => req.params.snapshot,
  })
  async removeSnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('snapshot') snapshot: string,
  ): Promise<void> {
    const scope = await this.scopeOf(boxId, authContext)
    await this.snapshotService.remove(authContext.organizationId, snapshot, scope)
  }

  @Post(':boxId/snapshots/:snapshot/restore')
  @HttpCode(202)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.RESTORE_SNAPSHOT,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: { snapshot: (req) => req.params.snapshot },
  })
  async restoreSnapshot(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('snapshot') snapshot: string,
  ): Promise<SnapshotRestoreResponse> {
    return restoreToResponse(await this.snapshotService.restore(boxId, snapshot, authContext.organizationId))
  }

  @Get(':boxId/restores/:restoreId')
  async getSnapshotRestore(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('boxId') boxId: string,
    @Param('restoreId') restoreId: string,
  ): Promise<SnapshotRestoreResponse> {
    return restoreToResponse(await this.snapshotService.getRestore(boxId, restoreId, authContext.organizationId))
  }

  private async scopeOf(boxIdOrName: string, authContext: OrganizationAuthContext): Promise<SnapshotScope> {
    const box = await this.boxService.findOneByIdOrName(boxIdOrName, authContext.organizationId)
    return { sourceBoxId: box.id }
  }
}

import { Audit, AUDIT_TARGET_ID } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { Request } from 'express'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { UserContext } from '../common/decorators/user-context.decorator'
import { Context } from '../common/context/context'
import { VolumeService } from '../box/services/volume.service'
import { CreateVolumeDto } from '../box/dto/create-volume.dto'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { VolumeAccessGuard } from '../box/guards/volume-access.guard'
import { VolumeState } from '../box/enums/volume-state.enum'

type RestVolumeSummary = {
  id: string
  name: string
  state: VolumeState
  storage_backend: 'object_storage' | 'filestore'
  created_at: string
  // Filestore-only: the NFS instance holding the volume's data directory.
  // Absent for object-storage volumes, whose data lives in boxlite-volume-<id>.
  instance?: string
}

type RestVolumeResponse = RestVolumeSummary & {
  updated_at: string
  last_used_at?: string
  error_reason?: string
}

@Controller(['v1/volumes', 'v1/:prefix/volumes'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteVolumeController {
  constructor(private readonly volumeService: VolumeService) {}

  @Post()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.VOLUME, targetIdFromResult: (result) => result.id })
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: CreateVolumeDto | undefined,
    @UserContext() ctx: Context,
    @Req() request?: Request,
  ): Promise<RestVolumeResponse> {
    // An absent body is an unnamed volume; VolumeService falls back to the id.
    const volume = await this.volumeService.create(authContext.organization, dto ?? {}, ctx)
    if (request) request[AUDIT_TARGET_ID] = volume.id
    return this.toResponse(await this.volumeService.waitForReady(volume.id, 30))
  }

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ volumes: RestVolumeSummary[] }> {
    const volumes = await this.volumeService.findAll(authContext.organizationId)
    return { volumes: volumes.map((volume) => this.toSummary(volume)) }
  }

  @Get(':volumeId')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  @UseGuards(VolumeAccessGuard)
  async get(@Param('volumeId') volumeId: string): Promise<RestVolumeResponse> {
    return this.toResponse(await this.volumeService.findOne(volumeId))
  }

  @Delete(':volumeId')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_VOLUMES])
  @UseGuards(VolumeAccessGuard)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.VOLUME,
    targetIdFromRequest: (req) => req.params.volumeId,
  })
  async remove(
    @Param('volumeId') volumeId: string,
    @Query('force') force: string | undefined,
    @UserContext() ctx: Context,
  ): Promise<void> {
    await this.volumeService.delete(volumeId, ctx, force === 'true')
  }

  private toResponse(volume: Awaited<ReturnType<VolumeService['findOne']>>): RestVolumeResponse {
    return {
      ...this.toSummary(volume),
      updated_at: volume.updatedAt.toISOString(),
      last_used_at: volume.lastUsedAt?.toISOString(),
      error_reason: volume.errorReason,
    }
  }

  private toSummary(volume: Awaited<ReturnType<VolumeService['findOne']>>): RestVolumeSummary {
    return {
      id: volume.id,
      name: volume.name,
      state: volume.state,
      storage_backend: volume.instance ? 'filestore' : 'object_storage',
      created_at: volume.createdAt.toISOString(),
      ...(volume.instance ? { instance: volume.instance } : {}),
    }
  }
}

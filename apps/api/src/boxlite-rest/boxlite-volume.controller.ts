import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { VolumeService } from '../box/services/volume.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { VolumeAccessGuard } from '../box/guards/volume-access.guard'
import { VolumeState } from '../box/enums/volume-state.enum'

type RestVolumeSummary = {
  id: string
  name: string
  state: VolumeState
  created_at: string
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
  @HttpCode(202)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async create(@AuthContext() authContext: OrganizationAuthContext): Promise<RestVolumeResponse> {
    // Returns as soon as the volume row exists (state=pending_create) — provisioning
    // the backing object storage happens asynchronously. Callers learn readiness via
    // GET or the volume.state.updated webhook (apps/api/src/webhook), same as the
    // pre-existing classic VolumeController.
    const volume = await this.volumeService.create(authContext.organization, {})
    return this.toResponse(volume)
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
  async remove(@Param('volumeId') volumeId: string, @Query('force') force?: string): Promise<void> {
    await this.volumeService.delete(volumeId, force === 'true')
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
      created_at: volume.createdAt.toISOString(),
    }
  }
}

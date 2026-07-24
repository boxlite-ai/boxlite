import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { VolumeService } from '../box/services/volume.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { VolumeAccessGuard } from '../box/guards/volume-access.guard'

type RestVolumeResponse = {
  id: string
  created_at: string
  size_bytes: number
}

@Controller(['v1/volumes', 'v1/:prefix/volumes'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteVolumeController {
  constructor(private readonly volumeService: VolumeService) {}

  @Post()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async create(@AuthContext() authContext: OrganizationAuthContext): Promise<RestVolumeResponse> {
    const volume = await this.volumeService.create(authContext.organization, {})
    return this.toResponse(await this.volumeService.waitUntilReady(volume.id))
  }

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ volumes: RestVolumeResponse[] }> {
    const volumes = await this.volumeService.findAll(authContext.organizationId)
    return { volumes: volumes.map((volume) => this.toResponse(volume)) }
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
    try {
      await this.volumeService.delete(volumeId)
    } catch (error) {
      if (force === 'true' && error instanceof NotFoundException) {
        return
      }
      throw error
    }
  }

  private toResponse(volume: Awaited<ReturnType<VolumeService['findOne']>>): RestVolumeResponse {
    return {
      id: volume.id,
      created_at: volume.createdAt.toISOString(),
      size_bytes: volume.sizeGiB * 1024 * 1024 * 1024,
    }
  }
}

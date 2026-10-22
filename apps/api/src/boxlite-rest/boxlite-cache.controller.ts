import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { RunnerService } from '../box/services/runner.service'
import { RegionService } from '../region/services/region.service'

@Controller(['v1/caches', 'v1/:prefix/caches'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteCacheController {
  constructor(
    private readonly runners: RunnerService,
    private readonly regions: RegionService,
  ) {}

  @Get(':runnerId/:cacheId')
  @RequiredOrganizationResourcePermissions([Permission.READ_VOLUMES])
  async getCache(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('runnerId', ParseUUIDPipe) runner: string,
    @Param('cacheId') id: string,
  ) {
    return this.request(auth, runner, id, 'GET')
  }

  @Delete(':runnerId/:cacheId')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([Permission.DELETE_VOLUMES])
  async removeCache(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('runnerId', ParseUUIDPipe) runner: string,
    @Param('cacheId') id: string,
    @Query('idle_before') cutoff?: string,
  ) {
    if (cutoff !== undefined && !Number.isFinite(Date.parse(cutoff)))
      throw new BadRequestException('invalid idle_before')
    await this.request(auth, runner, id, 'DELETE', cutoff)
  }

  private async request(auth: OrganizationAuthContext, runnerId: string, id: string, method: string, cutoff?: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequestException('invalid cache ID')
    const runner = await this.runners.findOne(runnerId)
    if (!runner || !(runner.apiUrl || runner.proxyUrl)) throw new NotFoundException('cache runner unavailable')
    const region = await this.regions.findOne(runner.region)
    if (!region || (region.organizationId && region.organizationId !== auth.organizationId))
      throw new NotFoundException('cache runner unavailable')
    const query = cutoff === undefined ? '' : `?idle_before=${encodeURIComponent(new Date(cutoff).toISOString())}`
    const response = await fetch(
      `${runner.apiUrl || runner.proxyUrl}/v1/caches/${encodeURIComponent(auth.organizationId)}/${encodeURIComponent(id)}${query}`,
      {
        method,
        headers: { Authorization: `Bearer ${runner.apiKey}` },
        signal: AbortSignal.timeout(30000),
      },
    )
    if (response.status === 204) return
    const data = await response.json()
    if (!response.ok)
      throw new HttpException(
        { message: data.error?.message ?? 'cache request failed', code: data.error?.code },
        response.status,
      )
    return { ...data, runner_id: runnerId }
  }
}

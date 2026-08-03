import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BoxWarmPoolService } from '../../box/services/box-warm-pool.service'
import { AdminWarmPoolDto, UpdateWarmPoolScheduleDto } from '../dto/warm-pool.dto'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'

@ApiTags('admin')
@Controller('admin/warm-pools')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminWarmPoolController {
  constructor(private readonly warmPoolService: BoxWarmPoolService) {}

  @Get()
  @ApiOperation({ summary: 'List all warm pools', operationId: 'adminListWarmPools' })
  @ApiResponse({ status: 200, type: [AdminWarmPoolDto] })
  async list(): Promise<AdminWarmPoolDto[]> {
    return (await this.warmPoolService.listWarmPools()).map(AdminWarmPoolDto.fromEntity)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get warm pool by ID', operationId: 'adminGetWarmPool' })
  @ApiResponse({ status: 200, type: AdminWarmPoolDto })
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<AdminWarmPoolDto> {
    const item = await this.warmPoolService.findWarmPool(id)
    if (!item) throw new NotFoundException('Warm pool not found')
    return AdminWarmPoolDto.fromEntity(item)
  }

  @Patch(':id/schedule')
  @ApiOperation({ summary: 'Update warm pool schedule config', operationId: 'adminUpdateWarmPoolSchedule' })
  @ApiResponse({ status: 200, type: AdminWarmPoolDto })
  @Audit({
    action: AuditAction.UPDATE_SCHEDULING,
    targetType: AuditTarget.WARM_POOL,
    targetIdFromRequest: (req) => req.params.id,
    requestMetadata: {
      body: (req: TypedRequest<UpdateWarmPoolScheduleDto>) => ({
        timezone: req.body?.timezone,
        scheduleConfig: req.body?.scheduleConfig,
      }),
    },
  })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarmPoolScheduleDto,
  ): Promise<AdminWarmPoolDto> {
    const item = await this.warmPoolService.findWarmPool(id)
    if (!item) throw new NotFoundException('Warm pool not found')
    const updated = await this.warmPoolService.updateSchedule(id, dto.scheduleConfig, dto.timezone)
    return AdminWarmPoolDto.fromEntity(updated)
  }
}

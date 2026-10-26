import { Controller, Get, Headers, Query, Res, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOAuth2,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { AuthContext as AuthContextType } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminUsageErrorDto, AdminUsagePageDto } from '../dto/usage.dto'
import { AdminUsageService } from '../services/usage.service'
import { parseUsageOwner, parseUsageRequest, USAGE_GRANULARITIES } from '../utils/usage-query'

@ApiTags('admin')
@Controller('admin')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminUsageController {
  constructor(private readonly usage: AdminUsageService) {}

  @Get('usage')
  @ApiOperation({
    summary: 'Query recorded resource usage with fixed snapshot pagination',
    operationId: 'adminQueryUsage',
  })
  @ApiQuery({
    name: 'from',
    type: String,
    required: true,
    description: 'Inclusive RFC 3339 instant, at most milliseconds.',
  })
  @ApiQuery({ name: 'to', type: String, required: true, description: 'Exclusive RFC 3339 instant, no later than now.' })
  @ApiQuery({ name: 'granularity', enum: USAGE_GRANULARITIES, required: false })
  @ApiQuery({
    name: 'metrics',
    type: String,
    required: false,
    description: 'Comma-separated computeVcpuSeconds,storageByteSeconds,memoryGibSeconds.',
  })
  @ApiQuery({
    name: 'groupBy',
    type: String,
    required: false,
    description: 'One or two of organizationId,regionId,boxId, comma-separated.',
  })
  @ApiQuery({ name: 'organizationId', type: String, required: false, format: 'uuid' })
  @ApiQuery({ name: 'regionId', type: String, required: false, maxLength: 128 })
  @ApiQuery({ name: 'boxId', type: String, required: false, maxLength: 128 })
  @ApiQuery({ name: 'limit', type: Number, required: false, minimum: 1, maximum: 200 })
  @ApiQuery({ name: 'cursor', type: String, required: false, maxLength: 2048 })
  @ApiHeader({
    name: 'X-Usage-Snapshot-Owner',
    required: false,
    description: 'Optional 64 lowercase hex caller partition; never authentication.',
  })
  @ApiOkResponse({ type: AdminUsagePageDto })
  @ApiResponse({ status: 400, type: AdminUsageErrorDto, description: 'Invalid query or cursor binding' })
  @ApiResponse({ status: 410, type: AdminUsageErrorDto, description: 'Snapshot expired; restart the complete query' })
  @ApiResponse({ status: 422, type: AdminUsageErrorDto, description: 'Query exceeds a resource limit' })
  @ApiResponse({ status: 503, type: AdminUsageErrorDto, description: 'Database or snapshot cache unavailable' })
  query(
    @Query() raw: Record<string, unknown>,
    @AuthContext() auth: AuthContextType,
    @Headers('x-usage-snapshot-owner') owner: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminUsagePageDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.usage.query(parseUsageRequest(raw), auth, parseUsageOwner(owner))
  }
}

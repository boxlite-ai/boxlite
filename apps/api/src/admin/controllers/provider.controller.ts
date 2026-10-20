import {
  applyDecorators,
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOAuth2,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import {
  AdminBoxDetailDto,
  AdminBoxOverviewPageDto,
  AdminComponentIdentitiesDto,
  AdminJobOverviewDto,
  AdminJobOverviewPageDto,
  AdminOrganizationDetailDto,
  AdminOrganizationOverviewPageDto,
  AdminRegionOverviewDto,
  AdminRegionOverviewPageDto,
} from '../dto/provider-overview.dto'
import { AdminOrganizationOverviewService } from '../services/organization-overview.service'
import { AdminPlatformOverviewService } from '../services/platform-overview.service'
import { AdminOrganizationMetadataPageDto, AdminOrganizationMetadataResultDto } from '../dto/organization-metadata.dto'
import { metadataQueryError, parseMetadataSections, parseRegistrationQuery } from '../utils/organization-metadata'

const bounded = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new BadRequestException('Invalid pagination')
  return parsed
}

const ApiCursorQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor returned by the previous page' }),
    ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 }),
    ApiBadRequestResponse({ description: 'Invalid cursor or limit' }),
  )

@ApiTags('admin')
@Controller('admin')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminProviderController {
  constructor(
    private readonly organizationsService: AdminOrganizationOverviewService,
    private readonly platform: AdminPlatformOverviewService,
  ) {}

  @Get('regions')
  @ApiOperation({ summary: 'List regions with capacity and health', operationId: 'adminListRegions' })
  @ApiCursorQueries()
  @ApiOkResponse({ type: AdminRegionOverviewPageDto })
  regions(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminRegionOverviewPageDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.platform.regions({ ...(cursor ? { cursor } : {}), limit: bounded(limit, 50) })
  }

  @Get('regions/:id')
  @ApiOperation({ summary: 'Get region capacity and health', operationId: 'adminGetRegion' })
  @ApiParam({ name: 'id', description: 'Region ID' })
  @ApiOkResponse({ type: AdminRegionOverviewDto })
  @ApiNotFoundResponse({ description: 'Region not found' })
  async region(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminRegionOverviewDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    const region = await this.platform.region(id)
    if (!region) throw new NotFoundException('Region not found')
    return region
  }

  @Get('boxes')
  @ApiOperation({ summary: 'List boxes with placement and health', operationId: 'adminListBoxesOverview' })
  @ApiCursorQueries()
  @ApiOkResponse({ type: AdminBoxOverviewPageDto })
  boxes(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminBoxOverviewPageDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.platform.boxes({ ...(cursor ? { cursor } : {}), limit: bounded(limit, 50) })
  }

  @Get('boxes/:id')
  @ApiOperation({ summary: 'Get box placement, health, and jobs', operationId: 'adminGetBoxOverview' })
  @ApiParam({ name: 'id', description: 'Box ID' })
  @ApiQuery({ name: 'jobCursor', required: false, description: 'Opaque job page cursor' })
  @ApiQuery({ name: 'sectionLimit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 })
  @ApiOkResponse({ type: AdminBoxDetailDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or section limit' })
  @ApiNotFoundResponse({ description: 'Box not found' })
  async box(
    @Param('id') id: string,
    @Query('jobCursor') jobCursor: string | undefined,
    @Query('sectionLimit') sectionLimit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminBoxDetailDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    const box = await this.platform.box(id, {
      ...(jobCursor ? { jobCursor } : {}),
      jobLimit: bounded(sectionLimit, 50),
    })
    if (!box) throw new NotFoundException('Box not found')
    return box
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List jobs with sanitized failure categories', operationId: 'adminListJobsOverview' })
  @ApiCursorQueries()
  @ApiOkResponse({ type: AdminJobOverviewPageDto })
  jobs(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminJobOverviewPageDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.platform.jobs({ ...(cursor ? { cursor } : {}), limit: bounded(limit, 50) })
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get a job with sanitized failure category', operationId: 'adminGetJobOverview' })
  @ApiParam({ name: 'id', description: 'Job ID' })
  @ApiOkResponse({ type: AdminJobOverviewDto })
  @ApiNotFoundResponse({ description: 'Job not found' })
  async job(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminJobOverviewDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    const job = await this.platform.job(id)
    if (!job) throw new NotFoundException('Job not found')
    return job
  }

  @Get('component-identities')
  @ApiOperation({ summary: 'Get API and runner version identities', operationId: 'adminGetComponentIdentities' })
  @ApiOkResponse({ type: AdminComponentIdentitiesDto })
  componentIdentities(@Res({ passthrough: true }) response: Response): Promise<AdminComponentIdentitiesDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.platform.componentIdentities()
  }

  @Get('organizations')
  @ApiOperation({ summary: 'List organization operational summaries', operationId: 'adminListOrganizationsOverview' })
  @ApiQuery({ name: 'q', required: false, minLength: 2, maxLength: 200, description: 'Organization ID or name' })
  @ApiCursorQueries()
  @ApiOkResponse({ type: AdminOrganizationOverviewPageDto })
  organizations(
    @Query('q') query: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminOrganizationOverviewPageDto> {
    if (query !== undefined && (query.trim().length < 2 || query.trim().length > 200)) {
      throw new BadRequestException('Invalid organization query')
    }
    response.setHeader('Cache-Control', 'private, no-store')
    return this.organizationsService.list({
      ...(query ? { query: query.trim() } : {}),
      ...(cursor ? { cursor } : {}),
      limit: bounded(limit, 50),
    })
  }

  @Get('organizations/metadata')
  @ApiOperation({ summary: 'List organization registration metadata', operationId: 'adminListOrganizationMetadata' })
  @ApiQuery({ name: 'q', required: false, type: String, minLength: 2, maxLength: 200 })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'Inclusive RFC 3339 instant, at most millisecond precision.',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'Exclusive RFC 3339 instant, at most millisecond precision.',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor returned by the previous page' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 })
  @ApiBadRequestResponse({ description: 'Invalid metadata query' })
  @ApiOkResponse({ type: AdminOrganizationMetadataPageDto })
  organizationMetadataList(@Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.organizationsService.list({ ...parseRegistrationQuery(query), metadata: true })
  }

  @Get('organizations/:organizationId/metadata')
  @ApiOperation({
    summary: 'Get organization metadata with optional usage',
    operationId: 'adminGetOrganizationMetadata',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiQuery({ name: 'memberCursor', required: false, type: String })
  @ApiQuery({ name: 'boxCursor', required: false, type: String })
  @ApiQuery({ name: 'sectionLimit', required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiQuery({ name: 'include', required: false, enum: ['usage'], description: 'Omit to avoid reading usage.' })
  @ApiOkResponse({ type: AdminOrganizationMetadataResultDto })
  @ApiBadRequestResponse({ description: 'Invalid metadata query' })
  async organizationMetadata(
    @Param('organizationId', new ParseUUIDPipe({ exceptionFactory: metadataQueryError })) organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store')
    return { item: await this.organizationsService.detail(organizationId, parseMetadataSections(query)) }
  }

  @Get('organizations/:organizationId')
  @ApiOperation({ summary: 'Get organization operational detail', operationId: 'adminGetOrganizationOverview' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiQuery({ name: 'memberCursor', required: false, description: 'Opaque member page cursor' })
  @ApiQuery({ name: 'boxCursor', required: false, description: 'Opaque box page cursor' })
  @ApiQuery({ name: 'sectionLimit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 })
  @ApiOkResponse({ type: AdminOrganizationDetailDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or section limit' })
  @ApiNotFoundResponse({ description: 'Organization not found' })
  async organization(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query('memberCursor') memberCursor: string | undefined,
    @Query('boxCursor') boxCursor: string | undefined,
    @Query('sectionLimit') sectionLimit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminOrganizationDetailDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    const limit = bounded(sectionLimit, 50)
    const organization = await this.organizationsService.detail(organizationId, {
      ...(memberCursor ? { memberCursor } : {}),
      ...(boxCursor ? { boxCursor } : {}),
      memberLimit: limit,
      boxLimit: limit,
    })
    if (!organization) throw new NotFoundException('Organization not found')
    return organization
  }
}

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
import { organizationQueryError, parseOrganizationSections, parseRegistrationQuery } from '../utils/organization-query'

const bounded = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) throw new BadRequestException('Invalid pagination')
  return parsed
}

const ApiCursorQueries = () =>
  applyDecorators(
    ApiQuery({
      name: 'cursor',
      type: String,
      required: false,
      description: 'Opaque cursor returned by the previous page',
    }),
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
  @ApiQuery({
    name: 'createdFrom',
    type: String,
    required: false,
    description: 'Inclusive RFC 3339 instant, at most milliseconds.',
  })
  @ApiQuery({
    name: 'createdTo',
    type: String,
    required: false,
    description: 'Exclusive RFC 3339 instant, at most milliseconds.',
  })
  @ApiCursorQueries()
  @ApiQuery({
    name: 'q',
    type: String,
    required: false,
    minLength: 2,
    maxLength: 200,
    description: 'Organization ID or name',
  })
  @ApiOkResponse({ type: AdminOrganizationOverviewPageDto })
  organizations(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminOrganizationOverviewPageDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    return this.organizationsService.list(parseRegistrationQuery(query))
  }

  @Get('organizations/:organizationId')
  @ApiOperation({ summary: 'Get organization operational detail', operationId: 'adminGetOrganizationOverview' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiQuery({
    name: 'include',
    type: String,
    required: false,
    description: 'Comma-separated usage,activation. Omit to read neither section.',
  })
  @ApiQuery({ name: 'sectionLimit', required: false, type: Number, minimum: 1, maximum: 200, example: 50 })
  @ApiQuery({ name: 'boxCursor', required: false, type: String, description: 'Opaque box page cursor' })
  @ApiQuery({ name: 'memberCursor', required: false, type: String, description: 'Opaque member page cursor' })
  @ApiOkResponse({ type: AdminOrganizationDetailDto })
  @ApiBadRequestResponse({ description: 'Invalid cursor or section limit' })
  @ApiNotFoundResponse({ description: 'Organization not found' })
  async organization(
    @Param('organizationId') organizationId: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminOrganizationDetailDto> {
    response.setHeader('Cache-Control', 'private, no-store')
    await new ParseUUIDPipe({ exceptionFactory: organizationQueryError }).transform(organizationId, {
      type: 'param',
      data: 'organizationId',
      metatype: String,
    })
    const organization = await this.organizationsService.detail(organizationId, parseOrganizationSections(query))
    if (!organization) throw new NotFoundException('Organization not found')
    return organization
  }
}

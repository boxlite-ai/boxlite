/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  Body,
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UsePipes,
  UseFilters,
  ValidationPipe,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { SystemActionGuard } from '../auth/system-action.guard'
import { RequiredApiRole } from '../common/decorators/required-role.decorator'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthContext as Administrator } from '../common/interfaces/auth-context.interface'
import { SystemRole } from '../user/enums/system-role.enum'
import {
  CiAdminConnection,
  CiAdminConnectionError,
  CiAdminConnectionPage,
  CiAdminCreate,
  CiAdminLookup,
  CiAdminPage,
  CiAdminUpdate,
  CiAdminVersion,
} from './ci-admin.dto'
import { CiAdminService } from './ci-admin.service'

// Keep the observed mapping in conflicts; the global product filter flattens exception details.
@Catch(ConflictException)
class CiAdminConflictFilter implements ExceptionFilter {
  catch(exception: ConflictException, host: ArgumentsHost) {
    const http = host.switchToHttp(),
      body = exception.getResponse()
    http
      .getResponse<Response>()
      .status(409)
      .json({
        path: http.getRequest<Request>().url,
        timestamp: new Date().toISOString(),
        statusCode: 409,
        error: 'Conflict',
        ...(typeof body === 'string' ? { message: body } : body),
      })
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiOAuth2(['openid', 'profile', 'email'])
@Controller('admin')
@ApiResponse({ status: 400, type: CiAdminConnectionError, description: 'Invalid request or precondition fields.' })
@ApiResponse({ status: 401, type: CiAdminConnectionError, description: 'Invalid credentials.' })
@ApiResponse({
  status: 403,
  type: CiAdminConnectionError,
  description: 'Current platform administrator authority is required.',
})
@ApiResponse({ status: 404, type: CiAdminConnectionError, description: 'Organization or connection not found.' })
@ApiResponse({
  status: 409,
  type: CiAdminConnectionError,
  description:
    'Existing, ambiguous or stale mapping; inspect connection or connections when present and repeat lookup.',
})
@UseFilters(CiAdminConflictFilter)
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class CiAdminController {
  constructor(private readonly service: CiAdminService) {}
  @Get('ci/connections')
  @ApiOperation({
    operationId: 'adminLookupCiConnections',
    summary: 'Find CI billing destinations for an exact GitHub account',
    description:
      'Requires account_type and exactly one of github_account or github_account_id. Includes disabled history. No organization membership or Box key scopes are required.',
  })
  @ApiResponse({ status: 200, type: CiAdminConnectionPage })
  lookup(@AuthContext() actor: Administrator, @Query() query: CiAdminLookup) {
    return this.service.lookup(actor, query)
  }
  @Get('organizations/:organizationId/ci/connections')
  @ApiOperation({ operationId: 'adminListCiConnections', summary: 'List retained CI connections for an organization' })
  @ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, type: CiAdminConnectionPage })
  list(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: CiAdminPage,
  ) {
    return this.service.list(actor, org, query)
  }
  @Post('organizations/:organizationId/ci/connections')
  @ApiOperation({
    operationId: 'adminCreateCiConnection',
    summary: 'Bind an installed GitHub CI App to a billing organization',
    description:
      'Uses App authentication, without GitHub user OAuth or either organization ownership. Defaults to conflict for any retained mapping. force:true requires observed expected_binding_id and expected_generation; omit both otherwise. New creation returns 201; replacement returns 200.',
  })
  @ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
  @ApiResponse({ status: 201, type: CiAdminConnection })
  @ApiResponse({ status: 200, type: CiAdminConnection })
  @ApiResponse({
    status: 502,
    type: CiAdminConnectionError,
    description: 'GitHub installation verification unavailable.',
  })
  @ApiResponse({
    status: 503,
    type: CiAdminConnectionError,
    description: 'CI App unavailable or connection capacity exceeded.',
  })
  async create(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() body: CiAdminCreate,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.create(actor, org, body)
    response.status(result.created ? 201 : 200)
    return result.connection
  }
  @Patch('organizations/:organizationId/ci/connections/:bindingId')
  @ApiOperation({
    operationId: 'adminUpdateCiConnection',
    summary: 'Update CI private-repository policy with an observed version',
  })
  @ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
  @ApiParam({ name: 'bindingId', type: String, format: 'uuid' })
  @ApiResponse({
    status: 200,
    type: CiAdminConnection,
    description: 'Updated connection, including the resulting generation.',
  })
  update(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('bindingId', ParseUUIDPipe) id: string,
    @Body() body: CiAdminUpdate,
  ) {
    return this.service.update(actor, org, id, body)
  }
  @Delete('organizations/:organizationId/ci/connections/:bindingId')
  @ApiOperation({
    operationId: 'adminDeleteCiConnection',
    summary: 'Disable a CI connection with an observed version',
    description:
      'The JSON body must contain expected_generation. Retains original workers and cleanup identities; stale versions return 409 without mutation.',
  })
  @ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
  @ApiParam({ name: 'bindingId', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Connection disabled; response body is empty.' })
  @HttpCode(204)
  remove(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('bindingId', ParseUUIDPipe) id: string,
    @Body() body: CiAdminVersion,
  ) {
    return this.service.remove(actor, org, id, body)
  }
}

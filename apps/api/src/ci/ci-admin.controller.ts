/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  Body,
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
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { SystemActionGuard } from '../auth/system-action.guard'
import { RequiredApiRole } from '../common/decorators/required-role.decorator'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthContext as Administrator } from '../common/interfaces/auth-context.interface'
import { SystemRole } from '../user/enums/system-role.enum'
import { CiAdminCreate, CiAdminLookup, CiAdminPage, CiAdminUpdate, CiAdminVersion } from './ci-admin.dto'
import { CiAdminService } from './ci-admin.service'

@Controller('admin')
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class CiAdminController {
  constructor(private readonly service: CiAdminService) {}
  @Get('ci/connections')
  lookup(@AuthContext() actor: Administrator, @Query() query: CiAdminLookup) {
    return this.service.lookup(actor, query)
  }
  @Get('organizations/:organizationId/ci/connections')
  list(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: CiAdminPage,
  ) {
    return this.service.list(actor, org, query)
  }
  @Post('organizations/:organizationId/ci/connections')
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
  update(
    @AuthContext() actor: Administrator,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('bindingId', ParseUUIDPipe) id: string,
    @Body() body: CiAdminUpdate,
  ) {
    return this.service.update(actor, org, id, body)
  }
  @Delete('organizations/:organizationId/ci/connections/:bindingId')
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

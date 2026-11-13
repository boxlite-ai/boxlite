/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Body, Controller, Get, Put, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthContext as UserAuthContext } from '../../common/interfaces/auth-context.interface'
import { SystemRole } from '../../user/enums/system-role.enum'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { EnvironmentAccessQueryDto, EnvironmentAccessUpdateDto } from '../dto/environment-access.dto'
import { EnvironmentAccessService } from '../services/environment-access.service'
import { Context } from '../../common/context/context'

@ApiExcludeController()
@Controller('admin/environment-access')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AdminEnvironmentAccessController {
  constructor(private readonly access: EnvironmentAccessService) {}

  @Get()
  lookup(@Query() query: EnvironmentAccessQueryDto) {
    return this.access.lookup(query.email)
  }

  @Put()
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.USER,
    targetIdFromRequest: (req) =>
      typeof req.body?.userId === 'string' && req.body.userId.length > 0 && req.body.userId.length <= 128
        ? req.body.userId
        : null,
    requestMetadata: { body: (req) => ({ allowed: req.body?.allowed }) },
  })
  update(@Body() body: EnvironmentAccessUpdateDto, @AuthContext() actor: UserAuthContext) {
    return this.access.update(
      body,
      Context.admin({ userId: actor.userId, authMethod: actor.apiKey ? 'api_key' : 'jwt' }),
    )
  }
}

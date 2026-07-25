/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { BOXLITE_BOX_READ_PERMISSIONS } from './boxlite-permission.policy'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'

// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
@UseGuards(AnonymousRateLimitGuard)
export class BoxliteConfigController {
  @Get('config')
  @RequiredOrganizationResourcePermissions(BOXLITE_BOX_READ_PERMISSIONS)
  getConfig() {
    return {
      capabilities: {
        snapshots_enabled: false,
        clone_enabled: false,
        export_enabled: false,
        import_enabled: false,
      },
    }
  }
}

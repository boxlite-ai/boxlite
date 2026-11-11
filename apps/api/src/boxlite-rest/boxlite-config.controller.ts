/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { TypedConfigService } from '../config/typed-config.service'

// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteConfigController {
  constructor(private readonly configService: TypedConfigService) {}

  @Get('config')
  getConfig() {
    return {
      api_version: this.configService.get('version'),
      capabilities: {
        privileged_enabled: true,
        snapshots_enabled: false,
        clone_enabled: false,
        export_enabled: false,
        import_enabled: false,
        inbound_update_enabled: true,
        private_tunnels_enabled: true,
        exec_user_enabled: true,
      },
    }
  }
}

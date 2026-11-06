/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'

// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteConfigController {
  constructor(@Optional() private readonly config?: ConfigService) {}

  @Get('config')
  getConfig() {
    return {
      capabilities: {
        checkpoints_enabled: !!this.config?.get('checkpoint.archivePrefix'),
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

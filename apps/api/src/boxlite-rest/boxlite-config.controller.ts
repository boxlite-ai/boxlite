/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { IDEMPOTENCY_KEY_LIFETIME } from './box-request.service'

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
        idempotency_key_lifetime: IDEMPOTENCY_KEY_LIFETIME,
        checkpoints_enabled:
          this.config?.get('checkpoint.enabled') === true && !!this.config?.get('checkpoint.archivePrefix'),
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

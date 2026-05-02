/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'

@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteConfigController {
  @Get('config')
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

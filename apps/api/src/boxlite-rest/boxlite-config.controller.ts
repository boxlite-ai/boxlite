/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { BoxSnapshotService } from '../box/services/box-snapshot.service'

// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteConfigController {
  constructor(private readonly snapshotService: BoxSnapshotService) {}

  @Get('config')
  getConfig() {
    return {
      capabilities: {
        // On wherever snapshot storage is configured (BOX_SNAPSHOT_ARCHIVE_PREFIX).
        snapshots_enabled: this.snapshotService.isEnabled(),
        clone_enabled: false,
        export_enabled: false,
        import_enabled: false,
        inbound_update_enabled: true,
      },
    }
  }
}

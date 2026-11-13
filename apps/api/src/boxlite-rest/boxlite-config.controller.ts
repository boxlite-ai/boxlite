/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Optional } from '@nestjs/common'
import { ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { TypedConfigService } from '../config/typed-config.service'
import { isVolumeStorageConfigured } from '../box/stores/volume-bucket.store'

// Spec-first surface: the contract is openapi/box.openapi.yaml.
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteConfigController {
  constructor(@Optional() private readonly config?: TypedConfigService) {}

  @Get('config')
  getConfig() {
    return {
      capabilities: {
        checkpoints_enabled:
          this.config?.get('checkpoint.enabled') === true && !!this.config?.get('checkpoint.archivePrefix'),
        object_storage_enabled: this.config ? isVolumeStorageConfigured(this.config) : false,
        filestore_enabled: (this.config?.getOrThrow('volume.filestoreInstances').instances.length ?? 0) > 0,
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

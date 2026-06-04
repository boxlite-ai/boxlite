/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get } from '@nestjs/common'
import { TypedConfigService } from './typed-config.service'
import { ApiOperation, ApiTags, ApiResponse } from '@nestjs/swagger'
import { ConfigurationDto } from './dto/configuration.dto'
import { OidcMetadataService } from './oidc-metadata.service'

@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(
    private readonly configService: TypedConfigService,
    private readonly oidcMetadataService: OidcMetadataService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get config' })
  @ApiResponse({
    status: 200,
    description: 'BoxLite configuration',
    type: ConfigurationDto,
  })
  async getConfig() {
    const endSessionState = await this.oidcMetadataService.getEndSessionState()
    return new ConfigurationDto(this.configService, { endSessionState })
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Post, Body, HttpCode, BadRequestException, Inject } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { ApiKeyService } from '../api-key/api-key.service'

@ApiTags('BoxLite REST')
@Controller('v1')
export class BoxliteAuthController {
  constructor(
    @Inject(ApiKeyService)
    private readonly apiKeyService: ApiKeyService,
  ) {}

  @Post('oauth/tokens')
  @HttpCode(200)
  async getToken(
    @Body() body: { grant_type?: string; client_id?: string; client_secret?: string },
  ) {
    if (body.grant_type !== 'client_credentials') {
      throw new BadRequestException('Only client_credentials grant type is supported')
    }

    if (!body.client_secret) {
      throw new BadRequestException('client_secret (API key) is required')
    }

    try {
      await this.apiKeyService.getApiKeyByValue(body.client_secret)
    } catch {
      throw new BadRequestException('Invalid API key')
    }

    return {
      access_token: body.client_secret,
      token_type: 'bearer',
      expires_in: 86400,
    }
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'

/**
 * OAuth 2.0 endpoints (RFC 8628 device flow + RFC 7009 revocation).
 *
 * **THIS IS A SCAFFOLDED CONTRACT, NOT A PRODUCTION OAUTH SERVER.** It
 * accepts the documented wire shape so the CLI's `--web` flow and the
 * OpenAPI spec round-trip, but the persistence layer (device_code →
 * pending → user authorized → tokens issued; refresh_token rotation with
 * family invalidation) is **deferred**. See `plan §16` for the follow-up
 * work that needs `@node-oauth/node-oauth2-server`, Postgres entities for
 * device codes + refresh tokens, and a dashboard consent UI.
 *
 * Until that ships, the device-flow endpoint returns a 501 with a
 * machine-readable error so CLIs can surface "use --api-key-stdin for now"
 * to users without ambiguity.
 *
 * Spec: `openapi/rest-sandbox-open-api.yaml` § `/v1/oauth/*`.
 */
@ApiTags('BoxLite REST')
@Controller('v1/oauth')
export class BoxliteOAuthController {
  private readonly logger = new Logger(BoxliteOAuthController.name)

  @Post('device_code')
  @HttpCode(503)
  initiateDeviceFlow(@Body() body: { client_id?: string; scope?: string }) {
    this.logger.warn(
      `device_code requested by client_id=${body.client_id} (server-side device flow not yet implemented)`,
    )
    throw new BadRequestException({
      error: 'temporarily_unavailable',
      error_description:
        'Browser device flow is not yet enabled on this server. Use an API key from the dashboard (`boxlite auth login --api-key-stdin`).',
    })
  }

  @Post('token')
  @HttpCode(503)
  exchangeToken(
    @Body()
    body: {
      grant_type?: string
      device_code?: string
      refresh_token?: string
      client_id?: string
    },
  ) {
    this.logger.warn(
      `oauth/token requested with grant_type=${body.grant_type} (not yet implemented)`,
    )
    throw new BadRequestException({
      error: 'temporarily_unavailable',
      error_description:
        'OAuth token exchange is not yet enabled on this server. Use an API key from the dashboard.',
    })
  }

  @Post('revoke')
  @HttpCode(200)
  revoke(@Body() _body: { token?: string; token_type_hint?: string }) {
    // RFC 7009 §2.2 — server always returns 200, even if the token is
    // unknown / already revoked / never existed. Idempotent.
    return {}
  }
}

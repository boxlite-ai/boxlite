/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { SecretCredentialService } from '../services/secret-credential.service'

export const SECRET_CREDENTIAL_PATH = 'internal/v1/credentials/introspect'

@ApiExcludeController()
@Controller(SECRET_CREDENTIAL_PATH)
export class SecretCredentialController {
  constructor(private readonly credentials: SecretCredentialService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  introspect(@Body() body: { token?: unknown; runner_id?: unknown } | undefined) {
    return this.credentials.consume(body?.token, body?.runner_id)
  }
}

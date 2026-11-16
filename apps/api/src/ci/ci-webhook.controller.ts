/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Controller, HttpCode, Post, Req } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Request } from 'express'
import { CiWebhookService } from './ci-webhook.service'

@Controller('v1/ci/github/webhook')
@ApiExcludeController()
export class CiWebhookController {
  constructor(private readonly service: CiWebhookService) {}
  @Post()
  @HttpCode(204)
  receive(@Req() request: Request) {
    return this.service.receive(
      request.body,
      request.get('x-hub-signature-256') || '',
      request.get('x-github-delivery') || '',
      request.get('x-github-event') || '',
    )
  }
  @Post('organization')
  @HttpCode(204)
  receiveOrganization(@Req() request: Request) {
    return this.service.receive(
      request.body,
      request.get('x-hub-signature-256') || '',
      request.get('x-github-delivery') || '',
      request.get('x-github-event') || '',
      'Organization',
    )
  }
}

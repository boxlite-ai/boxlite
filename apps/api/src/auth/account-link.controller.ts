/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkService } from './account-link.service'

/**
 * Called by the Post-Login Action, never by a browser: the request carries no
 * user session, only the Action's signed token.
 */
@ApiExcludeController()
@Controller('auth/link')
export class AccountLinkController {
  constructor(
    private readonly configService: TypedConfigService,
    private readonly accountLink: AccountLinkService,
  ) {}

  /** Move a social user's BoxLite data to the password account it is about to be linked into. */
  @Post('adopt')
  @HttpCode(204)
  @UseGuards(AnonymousRateLimitGuard)
  async adopt(@Headers('authorization') authorization?: string): Promise<void> {
    if (!this.configService.get('oidc.accountLink.enabled')) {
      throw new NotFoundException()
    }
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
    if (!token) {
      throw new UnauthorizedException('A bearer token is required.')
    }
    await this.accountLink.adopt(token)
  }
}

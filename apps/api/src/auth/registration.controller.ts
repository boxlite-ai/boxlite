/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { CustomHeaders } from '../common/constants/header.constants'
import { RegistrationJwtGuard, RegistrationRequest } from './registration-jwt.guard'
import { registrationToken } from './registration-request'
import { RegistrationService } from './registration.service'

@ApiExcludeController()
@Controller('auth/register')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post()
  @UseGuards(RegistrationJwtGuard)
  async register(
    @Req() request: RegistrationRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registration.register(
      request.registrationIdentity,
      registrationToken(body),
      request.get(CustomHeaders.REFERRAL_CODE.name),
    )
    response.status(result.created ? 201 : 200)
    return result.user
  }
}

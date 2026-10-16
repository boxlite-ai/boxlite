/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { IsDate, IsEmail, IsOptional, MinDate } from 'class-validator'

/** Body of `POST /v1/{prefix}/invitations`; see openapi/tenant.openapi.yaml CreateInvitationRequest. */
export class CreateInvitationDto {
  @IsEmail()
  email: string

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MinDate(() => new Date(), { message: 'expires_at must be in the future' })
  expires_at?: Date
}

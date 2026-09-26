/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { Request } from 'express'
import { OrganizationReferralCodeException } from '../exceptions/organization-referral-code.exception'

const registrationReferralCode = Symbol('registrationReferralCode')
type RegistrationRequest = Request & { [registrationReferralCode]?: unknown }

@Injectable()
export class RegistrationAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): RegistrationRequest {
    const request = context.switchToHttp().getRequest<RegistrationRequest>()
    request[registrationReferralCode] = request.query.referredCode
    return request
  }
}

// Called only for a missing local account; existing users ignore registration input.
export function getRegistrationReferralCode(request: RegistrationRequest): string | undefined {
  const value = request[registrationReferralCode]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new OrganizationReferralCodeException(HttpStatus.BAD_REQUEST, 'invalid_referral_code')
  }
  const code = value.trim().toUpperCase()
  if (!code) return undefined
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)) {
    throw new OrganizationReferralCodeException(HttpStatus.BAD_REQUEST, 'invalid_referral_code')
  }
  return code
}

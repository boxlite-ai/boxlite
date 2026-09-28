/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

type OrganizationReferralCodeError = 'invitation_unavailable' | 'referral_code_unavailable'

export class OrganizationReferralCodeException extends HttpException {
  constructor(status: HttpStatus, code: OrganizationReferralCodeError) {
    super({ statusCode: status, code, message: code }, status)
  }
}

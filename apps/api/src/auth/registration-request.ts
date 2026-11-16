/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

export function registrationToken(body: unknown): string {
  const token = body && typeof body === 'object' ? (body as Record<string, unknown>).turnstileToken : undefined
  if (token === undefined) {
    throw new BadRequestException({
      code: 'turnstile_token_required',
      message: 'Complete the verification to continue',
    })
  }
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) {
    throw new BadRequestException({ code: 'turnstile_token_invalid', message: 'Invalid verification token' })
  }
  return token
}

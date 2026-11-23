/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { isDisposableEmail } from '@visulima/disposable-email-domains/edge'
import { isEmail } from 'class-validator'
import { EmailUtils } from '../common/utils/email.util'
import { DisposableEmailException } from '../exceptions/disposable-email.exception'

export function normalizeRegistrationEmail(email: string): string {
  const normalized = EmailUtils.normalize(email)
  if (!isEmail(normalized)) {
    throw new BadRequestException({ message: 'Invalid email address', code: 'invalid_email' })
  }
  if (isDisposableEmail(normalized)) {
    throw new DisposableEmailException()
  }
  return normalized
}

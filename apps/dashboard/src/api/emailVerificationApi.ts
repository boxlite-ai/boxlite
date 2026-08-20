/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Configuration, UsersApi } from '@boxlite-ai/api-client'
import axios from 'axios'

export class EmailVerificationRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EmailVerificationRequestError'
  }
}

export async function resendEmailVerification(apiUrl: string, accessToken: string): Promise<void> {
  const usersApi = new UsersApi(
    new Configuration({
      basePath: apiUrl,
      accessToken,
    }),
  )

  try {
    await usersApi.resendEmailVerification()
  } catch (error) {
    if (!axios.isAxiosError(error)) {
      throw new EmailVerificationRequestError(
        'Unable to send a verification email. Please try again.',
        undefined,
        undefined,
        {
          cause: error instanceof Error ? error : undefined,
        },
      )
    }

    const status = error.response?.status
    const retryAfterSeconds = parseRetryAfter(error.response?.headers?.['retry-after'])
    const responseMessage = error.response?.data?.message
    const message =
      typeof responseMessage === 'string'
        ? responseMessage
        : status === 429
          ? 'Please wait before trying again.'
          : 'Unable to send a verification email. Please try again.'
    throw new EmailVerificationRequestError(message, status, retryAfterSeconds, { cause: error })
  }
}

function parseRetryAfter(value: unknown): number | undefined {
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

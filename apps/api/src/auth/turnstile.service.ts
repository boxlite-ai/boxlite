/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { TypedConfigService } from '../config/typed-config.service'

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name)

  constructor(private readonly config: TypedConfigService) {}

  async verify(token: string): Promise<void> {
    const settings = this.config.getOrThrow('turnstile')
    const started = Date.now()
    let signal: AbortSignal | undefined
    try {
      signal = AbortSignal.timeout(settings.timeoutMs)
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: settings.secretKey, response: token }),
        signal,
      })
      if (!response.ok) throw new Error('Siteverify HTTP failure')
      const result = await response.json()
      if (!result || typeof result.success !== 'boolean') throw new Error('Invalid Siteverify response')
      const errors = result['error-codes']
      if (
        Array.isArray(errors) &&
        errors.some((code) =>
          ['missing-input-secret', 'invalid-input-secret', 'internal-error', 'bad-request'].includes(code),
        )
      ) {
        throw new Error('Siteverify unavailable')
      }
      if (
        !result.success ||
        result.action !== settings.action ||
        typeof result.hostname !== 'string' ||
        !settings.expectedHostnames.includes(result.hostname.toLowerCase())
      ) {
        throw new ForbiddenException({
          code: 'turnstile_verification_failed',
          message: 'Verification failed. Please try again.',
        })
      }
      this.logger.debug({ event: 'registration.verification', outcome: 'success', durationMs: Date.now() - started })
    } catch (error) {
      const rejected = error instanceof ForbiddenException
      const outcome = rejected ? 'rejected' : signal?.aborted ? 'timeout' : 'unavailable'
      this.logger.warn({ event: 'registration.verification', outcome, durationMs: Date.now() - started })
      if (rejected) throw error
      throw new ServiceUnavailableException({
        code: 'turnstile_unavailable',
        message: 'Verification is temporarily unavailable',
      })
    }
  }
}

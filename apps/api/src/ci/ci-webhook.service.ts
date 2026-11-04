/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import { verifyWebhook, WebhookError, VerifiedWebhook } from '@boxlite-ai/ci-listener'
import { CiListenerService } from './ci-listener.service'
import { TypedConfigService } from '../config/typed-config.service'

@Injectable()
export class CiWebhookService {
  private receiving = 0
  private transactions = 0
  constructor(
    private readonly listener: CiListenerService,
    private readonly config: TypedConfigService,
  ) {}

  async receive(raw: unknown, signature: string, delivery: string, event: string): Promise<void> {
    // Retain the verification slot until this attempt settles; persistence
    // has a separate budget for transactions that outlive an HTTP response.
    if (this.receiving >= 32) throw new ServiceUnavailableException('CI webhook verification is busy')
    this.receiving++
    try {
      await this.verifyAndPersist(raw, signature, delivery, event)
    } finally {
      this.receiving--
    }
  }

  private async verifyAndPersist(raw: unknown, signature: string, delivery: string, event: string): Promise<void> {
    if (!Buffer.isBuffer(raw) || raw.length > 1_048_576) throw new BadRequestException('Raw webhook body required')
    if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new UnauthorizedException('Invalid webhook signature')
    const secret = await this.secret()
    let notification: VerifiedWebhook | null
    try {
      notification = verifyWebhook({ raw, signature, delivery, event }, secret)
    } catch (error) {
      if (error instanceof WebhookError) {
        if (error.status === 401) throw new UnauthorizedException(error.message)
        throw new BadRequestException(error.message)
      }
      throw error
    }
    if (!notification) return
    const app = this.config.get('ci.githubClientId')
    if (!app) throw new ServiceUnavailableException('CI App is not configured')
    if (this.transactions >= 32) throw new ServiceUnavailableException('CI webhook persistence is busy')
    this.transactions++
    const operation = this.listener
      .receive(notification)
      .catch((error) => {
        if (error instanceof WebhookError && error.status === 409) throw new ConflictException(error.message)
        throw new ServiceUnavailableException('CI webhook persistence unavailable')
      })
      .finally(() => {
        this.transactions--
      })
    let timeout: ReturnType<typeof setTimeout>
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new ServiceUnavailableException('CI webhook persistence timed out')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timeout!)
    }
  }

  private async secret(): Promise<Buffer> {
    const value = this.config.get('ci.githubWebhookSecret')
    if (typeof value !== 'string' || Buffer.byteLength(value) > 65536)
      throw new ServiceUnavailableException('GitHub webhook secret unavailable')
    const secret = Buffer.from(value.trim(), 'utf8')
    if (secret.length < 32 || secret.length > 256)
      throw new ServiceUnavailableException('GitHub webhook secret unavailable')
    return secret
  }
}

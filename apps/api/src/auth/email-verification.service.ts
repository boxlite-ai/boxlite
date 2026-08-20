/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import {
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import axios from 'axios'
import { createHash } from 'node:crypto'
import Redis from 'ioredis'
import { TypedConfigService } from '../config/typed-config.service'

const AUTH0_TIMEOUT_MS = 10_000
const RESEND_COOLDOWN_SECONDS = 60
const TOKEN_EXPIRY_SAFETY_SECONDS = 30

export interface EmailVerificationPrincipal {
  subject: string
  emailVerified: boolean
}

interface Auth0Identity {
  provider: string
  user_id: string
}

interface Auth0User {
  user_id: string
  email?: string
  email_verified?: boolean
  identities?: Auth0Identity[]
}

interface CachedManagementToken {
  value: string
  expiresAtMs: number
}

export class EmailVerificationCooldownException extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super('Please wait before requesting another verification email.', HttpStatus.TOO_MANY_REQUESTS)
  }
}

@Injectable()
export class EmailVerificationService implements OnModuleInit {
  private readonly logger = new Logger(EmailVerificationService.name)
  private cachedToken?: CachedManagementToken
  private tokenRequest?: Promise<string>

  constructor(
    private readonly configService: TypedConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    if (this.configService.get('skipUserEmailVerification')) {
      return
    }

    const requiredSettings: Array<[string, unknown]> = [
      ['OIDC_MANAGEMENT_API_ENABLED', this.configService.get('oidc.managementApi.enabled')],
      ['OIDC_MANAGEMENT_API_BASE_URL', this.configService.get('oidc.managementApi.baseUrl')],
      ['OIDC_MANAGEMENT_API_TOKEN_URL', this.configService.get('oidc.managementApi.tokenUrl')],
      ['OIDC_MANAGEMENT_API_CLIENT_ID', this.configService.get('oidc.managementApi.clientId')],
      ['OIDC_MANAGEMENT_API_CLIENT_SECRET', this.configService.get('oidc.managementApi.clientSecret')],
      ['OIDC_MANAGEMENT_API_AUDIENCE', this.configService.get('oidc.managementApi.audience')],
      ['OIDC_CLIENT_ID', this.configService.get('oidc.clientId')],
    ]
    const missing = requiredSettings
      .filter(([, value]) => value !== true && (typeof value !== 'string' || value.trim().length === 0))
      .map(([name]) => name)

    if (missing.length > 0) {
      throw new Error(
        `Email verification requires a complete Auth0 Management API adapter; missing ${missing.join(', ')}`,
      )
    }
  }

  async resend(principal: EmailVerificationPrincipal): Promise<void> {
    if (principal.emailVerified) {
      throw new ConflictException('Email address is already verified')
    }

    const cooldownKey = this.cooldownKey(principal.subject)
    await this.acquireCooldown(cooldownKey)

    try {
      const token = await this.getManagementToken()
      const user = await this.getAuth0User(principal.subject, token)

      if (user.email_verified === true) {
        throw new ConflictException('Email address is already verified')
      }
      if (!user.email?.trim()) {
        throw new UnprocessableEntityException('The identity provider account has no usable email address')
      }

      await this.queueVerificationEmail(user, token)
    } catch (error) {
      await this.releaseCooldown(cooldownKey)
      throw error
    }
  }

  private async acquireCooldown(key: string): Promise<void> {
    try {
      const acquired = await this.redis.set(key, '1', 'EX', RESEND_COOLDOWN_SECONDS, 'NX')
      if (acquired === 'OK') {
        return
      }

      const remainingSeconds = await this.redis.ttl(key)
      throw new EmailVerificationCooldownException(remainingSeconds > 0 ? remainingSeconds : RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      if (error instanceof EmailVerificationCooldownException) {
        throw error
      }
      throw new ServiceUnavailableException('Email verification cooldown is temporarily unavailable', {
        cause: error instanceof Error ? error : undefined,
      })
    }
  }

  private async releaseCooldown(key: string): Promise<void> {
    try {
      await this.redis.del(key)
    } catch (error) {
      this.logger.warn(`Failed to release email verification cooldown: ${this.errorMessage(error)}`)
    }
  }

  private async getAuth0User(subject: string, token: string): Promise<Auth0User> {
    try {
      const response = await axios.get<Auth0User>(this.managementUrl(`users/${encodeURIComponent(subject)}`), {
        headers: { Authorization: `Bearer ${token}` },
        timeout: AUTH0_TIMEOUT_MS,
      })
      return response.data
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === HttpStatus.NOT_FOUND) {
        throw new UnprocessableEntityException('The identity provider account could not be resolved')
      }
      throw this.upstreamException('read the identity provider account', error)
    }
  }

  private async queueVerificationEmail(user: Auth0User, token: string): Promise<void> {
    const identity = this.verificationIdentity(user)
    const customDomain = this.configService.get('oidc.managementApi.customDomain')?.trim()

    try {
      await axios.post(
        this.managementUrl('jobs/verification-email'),
        {
          user_id: user.user_id,
          client_id: this.configService.getOrThrow('oidc.clientId'),
          ...(identity ? { identity } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(customDomain ? { 'auth0-custom-domain': customDomain } : {}),
          },
          timeout: AUTH0_TIMEOUT_MS,
        },
      )
    } catch (error) {
      throw this.upstreamException('queue the verification email', error)
    }
  }

  private verificationIdentity(user: Auth0User): Auth0Identity | undefined {
    const separator = user.user_id.indexOf('|')
    if (separator <= 0) {
      return undefined
    }

    const provider = user.user_id.slice(0, separator)
    if (provider === 'auth0') {
      return undefined
    }

    const providerUserId = user.user_id.slice(separator + 1)
    const identity = user.identities?.find(
      (candidate) => candidate.provider === provider && candidate.user_id === providerUserId,
    )
    if (!identity) {
      throw new UnprocessableEntityException('The identity provider account has no usable email identity')
    }
    return { provider: identity.provider, user_id: identity.user_id }
  }

  private async getManagementToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now()) {
      return this.cachedToken.value
    }
    if (this.tokenRequest) {
      return this.tokenRequest
    }

    this.tokenRequest = this.requestManagementToken()
    try {
      return await this.tokenRequest
    } finally {
      this.tokenRequest = undefined
    }
  }

  private async requestManagementToken(): Promise<string> {
    try {
      const response = await axios.post<{ access_token?: string; expires_in?: number }>(
        this.configService.getOrThrow('oidc.managementApi.tokenUrl'),
        {
          grant_type: 'client_credentials',
          client_id: this.configService.getOrThrow('oidc.managementApi.clientId'),
          client_secret: this.configService.getOrThrow('oidc.managementApi.clientSecret'),
          audience: this.configService.getOrThrow('oidc.managementApi.audience'),
        },
        { timeout: AUTH0_TIMEOUT_MS },
      )
      const token = response.data.access_token
      if (!token) {
        throw new Error('Identity provider token response did not contain access_token')
      }
      const expiresInSeconds = Math.max(response.data.expires_in ?? 60, TOKEN_EXPIRY_SAFETY_SECONDS + 1)
      this.cachedToken = {
        value: token,
        expiresAtMs: Date.now() + (expiresInSeconds - TOKEN_EXPIRY_SAFETY_SECONDS) * 1000,
      }
      return token
    } catch (error) {
      throw this.upstreamException('obtain an identity provider management token', error)
    }
  }

  private managementUrl(path: string): string {
    return `${this.configService.getOrThrow('oidc.managementApi.baseUrl').replace(/\/+$/, '')}/${path}`
  }

  private cooldownKey(subject: string): string {
    const subjectHash = createHash('sha256').update(subject).digest('hex')
    return `email-verification:resend:${subjectHash}`
  }

  private upstreamException(operation: string, error: unknown): HttpException {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const options = { cause: error instanceof Error ? error : undefined }
    this.logger.error(`Failed to ${operation}: ${this.errorMessage(error)}`)

    if (status !== undefined && status < HttpStatus.INTERNAL_SERVER_ERROR) {
      return new BadGatewayException(`Identity provider rejected the request to ${operation}`, options)
    }
    return new ServiceUnavailableException(
      `Identity provider is temporarily unavailable while trying to ${operation}`,
      options,
    )
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

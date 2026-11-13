/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import axios from 'axios'
import { TypedConfigService } from '../../config/typed-config.service'
import { EnvironmentAccessUpdateDto } from '../dto/environment-access.dto'
import { EnvironmentAccessCleanupService } from './environment-access-cleanup.service'
import { Context } from '../../common/context/context'

interface Identity {
  user_id: string
  email: string
  email_verified?: boolean
  blocked?: boolean
  app_metadata?: Record<string, unknown>
}

const HTTP_LIMITS = { timeout: 5000, maxRedirects: 0, maxContentLength: 262144, maxBodyLength: 16384 }
const normalize = (email: string) => email.trim().toLowerCase()

@Injectable()
export class EnvironmentAccessService {
  private token?: { value: string; expiresAt: number }
  private tokenRequest?: Promise<string>
  private active = 0

  constructor(
    private readonly config: TypedConfigService,
    private readonly cleanup: EnvironmentAccessCleanupService,
  ) {}

  lookup(email: string) {
    return this.run(async (environment) => {
      const identities = new Map<string, Identity>()
      // Auth0 email lookup is immediately consistent but case-sensitive.
      for (const address of new Set([email, normalize(email)])) {
        const values = await this.management('GET', `users-by-email?email=${encodeURIComponent(address)}`)
        if (!Array.isArray(values) || values.length > 100) throw this.unavailable()
        for (const value of values) {
          const identity = this.identity(value)
          if (normalize(identity.email) !== normalize(email)) throw this.unavailable()
          identities.set(identity.user_id, identity)
        }
      }
      const items = []
      for (const identity of identities.values()) {
        items.push({ ...this.describe(identity, environment), ...(await this.cleanup.describe(identity.user_id)) })
      }
      return { environment, items }
    })
  }

  update(input: EnvironmentAccessUpdateDto, context: Context) {
    return this.run(async (environment) => {
      const actor = context.actor
      if (!actor?.userId) throw new UnauthorizedException('An authenticated administrator is required')
      const path = `users/${encodeURIComponent(input.userId)}`
      const identity = this.identity(await this.management('GET', path))
      const email = normalize(input.email)
      if (identity.user_id !== input.userId || normalize(identity.email) !== email) {
        throw new ConflictException('The Auth0 identity no longer matches this email; look it up again')
      }
      await this.management('PATCH', path, {
        app_metadata: {
          [`boxlite_${environment}_access`]: {
            email,
            allowed: input.allowed,
            updatedAt: new Date().toISOString(),
            updatedBy: actor.userId,
          },
        },
      })
      const cleanup = input.allowed ? undefined : await this.cleanup.revoke(input.userId, context)
      const updated = this.identity(await this.management('GET', path))
      const item = this.describe(updated, environment)
      if (
        updated.user_id !== input.userId ||
        normalize(updated.email) !== email ||
        (input.allowed ? !item.granted : !item.denied)
      )
        throw new ConflictException('The access update could not be confirmed; inspect current state before retrying')
      return {
        environment,
        item: { ...item, ...(await this.cleanup.describe(input.userId)) },
        ...(cleanup ? { cleanup } : {}),
      }
    })
  }

  private describe(identity: Identity, environment: string) {
    const email = normalize(identity.email)
    const raw = identity.app_metadata?.[`boxlite_${environment}_access`]
    const grant = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
    const matches = grant?.email === email
    return {
      userId: identity.user_id,
      email: identity.email,
      emailVerified: identity.email_verified === true,
      blocked: identity.blocked === true,
      company: email.split('@')[1] === 'polygala.ai',
      granted: matches && grant?.allowed === true,
      denied: matches && grant?.allowed === false,
    }
  }

  private identity(value: unknown): Identity {
    if (!value || typeof value !== 'object') throw this.unavailable()
    const identity = value as Identity
    if (
      typeof identity.user_id !== 'string' ||
      !identity.user_id ||
      identity.user_id.length > 128 ||
      typeof identity.email !== 'string' ||
      !identity.email ||
      identity.email.length > 320
    )
      throw this.unavailable()
    return identity
  }

  private async run<T>(operation: (environment: 'dev' | 'stage') => Promise<T>): Promise<T> {
    const environment = this.config.get('oidc.environmentAccess')
    if (!environment) throw new NotFoundException('Environment access management is disabled')
    if (this.active >= 8) throw this.unavailable()
    this.active++
    try {
      return await operation(environment)
    } finally {
      this.active--
    }
  }

  private async management(method: 'GET' | 'PATCH', path: string, data?: unknown): Promise<unknown> {
    try {
      const response = await axios.request({
        ...HTTP_LIMITS,
        method,
        url: `${this.config.getOrThrow('oidc.managementApi.baseUrl')}/${path}`,
        headers: { Authorization: `Bearer ${await this.managementToken()}` },
        data,
      })
      return response.data
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404 && path.startsWith('users/')) {
        throw new NotFoundException('Auth0 identity no longer exists')
      }
      this.token = undefined
      throw this.unavailable()
    }
  }

  private async managementToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    if (this.tokenRequest) return this.tokenRequest
    const request = this.requestToken()
    this.tokenRequest = request
    try {
      return await request
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = undefined
    }
  }

  private async requestToken(): Promise<string> {
    const startedAt = Date.now()
    const { data } = await axios.post(
      this.config.getOrThrow('oidc.managementApi.tokenUrl'),
      {
        grant_type: 'client_credentials',
        client_id: this.config.getOrThrow('oidc.managementApi.clientId'),
        client_secret: this.config.getOrThrow('oidc.managementApi.clientSecret'),
        audience: this.config.getOrThrow('oidc.managementApi.audience'),
      },
      HTTP_LIMITS,
    )
    if (
      typeof data?.access_token !== 'string' ||
      !data.access_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw this.unavailable()
    this.token = { value: data.access_token, expiresAt: startedAt + Math.max(0, data.expires_in - 60) * 1000 }
    return data.access_token
  }

  private unavailable() {
    return new ServiceUnavailableException('Environment access could not be confirmed; inspect state before retrying')
  }
}

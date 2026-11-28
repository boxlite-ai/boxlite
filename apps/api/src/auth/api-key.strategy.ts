/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, UnauthorizedException, Logger, OnModuleInit } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-http-bearer'
import { ApiKeyService } from '../api-key/api-key.service'
import { ApiKey } from '../api-key/api-key.entity'
import { UserService } from '../user/user.service'
import { AuthContextType } from '../common/interfaces/auth-context.interface'
import { TypedConfigService } from '../config/typed-config.service'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { SystemRole } from '../user/enums/system-role.enum'
import { RunnerService } from '../box/services/runner.service'
import { apiKeyValidationCacheKey, generateApiKeyHash } from '../common/utils/api-key'
import { RegionService } from '../region/services/region.service'
import { JWT_REGEX } from './constants/jwt-regex.constant'
import { TtlLruCache } from '../common/utils/ttl-lru-cache.util'
import { recordApiModuleCacheAccess } from '../common/utils/cache-metrics.util'
import { Singleflight } from '../common/utils/singleflight.util'
import { WithInstrumentation } from '../common/decorators/otel.decorator'

export type ApiKeyUserCache = {
  userId: string
  role: SystemRole
  email: string
}

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') implements OnModuleInit {
  private readonly logger = new Logger(ApiKeyStrategy.name)
  private readonly runnerAuthCache = new TtlLruCache<string, AuthContextType>(10_000, 60_000)
  private readonly validationSingleflight = new Singleflight()

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly apiKeyService: ApiKeyService,
    private readonly userService: UserService,
    private readonly configService: TypedConfigService,
    private readonly runnerService: RunnerService,
    private readonly regionService: RegionService,
  ) {
    super()
    this.logger.log('ApiKeyStrategy constructor called')
  }

  onModuleInit() {
    this.logger.log('ApiKeyStrategy initialized')
  }

  @WithInstrumentation('auth.api_key_validate')
  async validate(token: string): Promise<AuthContextType | null> {
    return this.validationSingleflight.run(generateApiKeyHash(token), () => this.validateUncached(token))
  }

  private async validateUncached(token: string): Promise<AuthContextType | null> {
    this.logger.debug('Validate method called')

    // Tokens matching JWT structure are not API keys. Return null so Passport can continue with the JWT strategy.
    if (JWT_REGEX.test(token)) {
      return null
    }

    const proxyApiKey = this.configService.get('proxy.apiKey')
    if (proxyApiKey && proxyApiKey === token) {
      return {
        role: 'proxy',
      }
    }

    const otelCollectorApiKey = this.configService.get('otelCollector.apiKey')
    if (otelCollectorApiKey && otelCollectorApiKey === token) {
      return {
        role: 'otel-collector',
      }
    }

    const healthCheckApiKey = this.configService.get('healthCheck.apiKey')
    if (healthCheckApiKey && healthCheckApiKey === token) {
      return {
        role: 'health-check',
      }
    }

    const billingApiKey = this.configService.get('billing.apiKey')
    if (billingApiKey && billingApiKey === token) {
      return {
        role: 'billing',
      }
    }

    const runnerCacheEnabled = this.isRunnerAuthCacheEnabled()
    const cachedRunner = runnerCacheEnabled ? this.runnerAuthCache.get(generateApiKeyHash(token)) : undefined
    if (cachedRunner) {
      recordApiModuleCacheAccess('runner_auth', 'hit')
      return cachedRunner
    }
    recordApiModuleCacheAccess('runner_auth', runnerCacheEnabled ? 'miss' : 'bypass')

    try {
      const apiKey = await this.findApiKey(token)
      await this.apiKeyService.updateLastUsedAt(apiKey.organizationId, apiKey.userId, apiKey.name, new Date())

      const userCache = await this.findUser(apiKey.userId)
      if (!userCache) {
        this.logger.error(`Api key has invalid user: ${apiKey.keySuffix} - ${apiKey.userId}`)
        throw new UnauthorizedException('User not found')
      }

      const result = {
        userId: userCache.userId,
        role: userCache.role,
        email: userCache.email,
        apiKey,
        organizationId: apiKey.organizationId,
      }

      this.logger.debug('Authentication successful', result)
      return result
    } catch (error) {
      this.logger.debug('Error checking user API key:', error)
      // Continue to check runner API keys if user check fails
    }

    try {
      const runner = await this.runnerService.findByApiKey(token)
      if (runner) {
        this.logger.debug(`Runner API key found for runner: ${runner.id}`)
        const context: AuthContextType = {
          role: 'runner',
          runnerId: runner.id,
          runner,
        }
        if (this.isRunnerAuthCacheEnabled()) this.runnerAuthCache.set(generateApiKeyHash(token), context)
        return context
      }
    } catch (error) {
      this.logger.debug('Error checking runner API key:', error)
    }

    try {
      const region = await this.regionService.findOneByProxyApiKey(token)
      if (region) {
        this.logger.debug(`Region proxy API key found for region: ${region.id}`)
        return {
          role: 'region-proxy',
          regionId: region.id,
        }
      }
    } catch (error) {
      this.logger.debug('Error checking region proxy API key:', error)
    }

    return null
  }

  private isRunnerAuthCacheEnabled(): boolean {
    return this.configService.get('runnerAuthCache.enabled') !== false
  }

  @WithInstrumentation('auth.api_key_lookup')
  async findApiKey(token: string): Promise<ApiKey> {
    return this.readApiKey(generateApiKeyHash(token), () => this.apiKeyService.getApiKeyByValue(token))
  }

  @WithInstrumentation('auth.api_key_hash_lookup')
  async findApiKeyByHash(keyHash: string): Promise<ApiKey> {
    return this.readApiKey(keyHash, () => this.apiKeyService.getApiKeyByHash(keyHash))
  }

  private async readApiKey(keyHash: string, loader: () => Promise<ApiKey>): Promise<ApiKey> {
    let apiKey = await this.getApiKeyCache(keyHash)
    recordApiModuleCacheAccess('api_key', apiKey ? 'hit' : 'miss')
    if (!apiKey) {
      apiKey = await loader()
      this.logger.debug(`API key found for userId: ${apiKey.userId}`)
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        throw new UnauthorizedException('This API key has expired')
      }
      const validationCacheTtl = this.configService.get('apiKey.validationCacheTtlSeconds')
      await this.redis.setex(apiKeyValidationCacheKey(keyHash), validationCacheTtl, JSON.stringify(apiKey))
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('This API key has expired')
    }
    return apiKey
  }

  @WithInstrumentation('auth.user_lookup')
  async findUser(userId: string): Promise<ApiKeyUserCache | null> {
    let userCache = await this.getUserCache(userId)
    recordApiModuleCacheAccess('api_key_user', userCache ? 'hit' : 'miss')
    if (userCache) return userCache

    const user = await this.userService.findOne(userId)
    if (!user) return null
    userCache = { userId: user.id, role: user.role, email: user.email }
    const userCacheTtl = this.configService.get('apiKey.userCacheTtlSeconds')
    await this.redis.setex(`api-key:user:${userId}`, userCacheTtl, JSON.stringify(userCache))
    return userCache
  }

  private async getUserCache(userId: string): Promise<ApiKeyUserCache | null> {
    try {
      const userCacheRaw = await this.redis.get(`api-key:user:${userId}`)
      if (userCacheRaw) {
        return JSON.parse(userCacheRaw)
      }
      return null
    } catch (error) {
      this.logger.error('Error getting user cache:', error)
      return null
    }
  }

  private async getApiKeyCache(keyHash: string): Promise<ApiKey | null> {
    try {
      const cached = await this.redis.get(apiKeyValidationCacheKey(keyHash))
      if (cached) {
        this.logger.debug('Using cached API key validation')
        const apiKey = JSON.parse(cached)
        // Preserve the shared revocation key while old cache entries age out after the scope migration.
        apiKey.permissions = apiKey.permissions?.map((permission: string) =>
          permission === 'read:tenant' ? 'read:members' : permission === 'write:tenant' ? 'write:members' : permission,
        )
        if (apiKey.createdAt) apiKey.createdAt = new Date(apiKey.createdAt)
        if (apiKey.lastUsedAt) apiKey.lastUsedAt = new Date(apiKey.lastUsedAt)
        if (apiKey.expiresAt) apiKey.expiresAt = new Date(apiKey.expiresAt)
        return apiKey
      }
      return null
    } catch (error) {
      this.logger.error('Error getting API key cache:', error)
      return null
    }
  }
}

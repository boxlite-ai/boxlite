/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, Inject, ExecutionContext, Optional } from '@nestjs/common'
import { ThrottlerGuard, ThrottlerRequest, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { OrganizationService } from '../../organization/services/organization.service'
import { THROTTLER_SCOPE_KEY } from '../decorators/throttler-scope.decorator'
import { AuthContextType } from '../interfaces/auth-context.interface'

type RateLimitAuthContext = AuthContextType & {
  organizationId?: string
  userId?: string
}

type AuthenticatedRequest = Request & {
  user?: RateLimitAuthContext
}

@Injectable()
export class AuthenticatedRateLimitGuard extends ThrottlerGuard {
  private readonly logger = new Logger(AuthenticatedRateLimitGuard.name)

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(getRedisConnectionToken('throttler')) private readonly redis: Redis,
    @Optional() private readonly organizationService?: OrganizationService,
  ) {
    super(options, storageService, reflector)
  }

  protected async getTracker(req: Request): Promise<string> {
    const user = (req as AuthenticatedRequest).user

    // Track by organization ID when available (shared quota per org)
    if (user?.organizationId) {
      return `auth:org:${user.organizationId}`
    }

    // Fallback to user ID for non-org routes (e.g., /users/me)
    if (user?.userId) {
      return `auth:user:${user.userId}`
    }

    // Ultimate fallback (shouldn't happen in normal flow)
    const ip = req.ips.length ? req.ips[0] : req.ip
    return `fallback:${ip}`
  }

  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    // Override to make rate limiting per-rate-limit-type, not per-route
    // This ensures all routes share the same counter per rate limit type (authenticated, box-create, box-lifecycle)
    return `${name}-${suffix}`
  }

  async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const isAuthenticated = request.user && this.isValidAuthContext(request.user)

    // Skip rate limiting for M2M system roles (checked AFTER auth runs)
    if (this.isSystemRole(request.user)) {
      return true
    }

    // Skip anonymous throttler (handled by AnonymousRateLimitGuard on public routes)
    if (throttler.name === 'anonymous') {
      return true
    }

    // Skip failed-auth throttler (handled by FailedAuthRateLimitMiddleware and auth guards)
    if (throttler.name === 'failed-auth') {
      return true
    }

    // Check authenticated throttlers
    const authenticatedThrottlers = ['authenticated', 'box-create', 'box-lifecycle']
    if (authenticatedThrottlers.includes(throttler.name)) {
      if (isAuthenticated) {
        // Only 'authenticated' applies to all routes by default
        // 'box-create' and 'box-lifecycle' only apply if explicitly configured via @SkipThrottle or @Throttle
        const isDefaultThrottler = throttler.name === 'authenticated'

        if (!isDefaultThrottler) {
          // Box throttlers (box-create, box-lifecycle) are opt-in only
          // Check if this route declares this throttler scope via @ThrottlerScope() decorator
          const scopes = this.reflector.getAllAndOverride<string[]>(THROTTLER_SCOPE_KEY, [
            context.getHandler(),
            context.getClass(),
          ])

          // If the route hasn't declared this throttler in its scope, skip it
          if (!scopes || !scopes.includes(throttler.name)) {
            return true
          }
        }

        const user = request.user
        const orgId = user?.organizationId
        if (orgId) {
          const orgLimits = await this.getCachedOrganizationRateLimits(orgId)
          if (orgLimits) {
            const customLimit =
              throttler.name === 'authenticated'
                ? orgLimits.authenticated
                : throttler.name === 'box-create'
                  ? orgLimits.boxCreate
                  : throttler.name === 'box-lifecycle'
                    ? orgLimits.boxLifecycle
                    : undefined

            const customTtlSeconds =
              throttler.name === 'authenticated'
                ? orgLimits.authenticatedTtlSeconds
                : throttler.name === 'box-create'
                  ? orgLimits.boxCreateTtlSeconds
                  : throttler.name === 'box-lifecycle'
                    ? orgLimits.boxLifecycleTtlSeconds
                    : undefined

            if (customLimit != null || customTtlSeconds != null) {
              const modifiedProps = {
                ...requestProps,
                ...(customLimit != null && { limit: customLimit }),
                ...(customTtlSeconds != null && {
                  ttl: customTtlSeconds * 1000,
                  blockDuration: customTtlSeconds * 1000,
                }),
              }
              return super.handleRequest(modifiedProps)
            }
          }
        }
        return super.handleRequest(requestProps)
      }
      return true
    }

    // For any other throttlers, defer to base ThrottlerGuard
    if (isAuthenticated) {
      return super.handleRequest(requestProps)
    }
    return true
  }

  private isValidAuthContext(user: RateLimitAuthContext | undefined): boolean {
    return Boolean(user && (user.userId || user.role))
  }

  private isSystemRole(user: RateLimitAuthContext | undefined): boolean {
    // Skip rate limiting for M2M system roles (proxy, runner, ssh-gateway)
    return user?.role === 'ssh-gateway' || user?.role === 'proxy' || user?.role === 'runner'
  }

  private async getCachedOrganizationRateLimits(organizationId: string): Promise<{
    authenticated: number | null
    boxCreate: number | null
    boxLifecycle: number | null
    authenticatedTtlSeconds: number | null
    boxCreateTtlSeconds: number | null
    boxLifecycleTtlSeconds: number | null
  } | null> {
    // If OrganizationService is not available (e.g., in UserModule), use default rate limits
    if (!this.organizationService) {
      return null
    }

    try {
      const cacheKey = `organization:rate-limits:${organizationId}`
      const cachedLimits = await this.redis.get(cacheKey)

      if (cachedLimits) {
        return JSON.parse(cachedLimits)
      }

      const organization = await this.organizationService.findOne(organizationId)
      if (organization) {
        const limits = {
          authenticated: organization.authenticatedRateLimit,
          boxCreate: organization.boxCreateRateLimit,
          boxLifecycle: organization.boxLifecycleRateLimit,
          authenticatedTtlSeconds: organization.authenticatedRateLimitTtlSeconds,
          boxCreateTtlSeconds: organization.boxCreateRateLimitTtlSeconds,
          boxLifecycleTtlSeconds: organization.boxLifecycleRateLimitTtlSeconds,
        }
        await this.redis.set(cacheKey, JSON.stringify(limits), 'EX', 60)
        return limits
      }

      return null
    } catch (error) {
      this.logger.error('Error getting cached organization rate limits:', error)
      return null
    }
  }
}

/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { passportJwtSecret } from 'jwks-rsa'
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose'
import { UserService } from '../user/user.service'
import { AuthContext } from '../common/interfaces/auth-context.interface'
import { Request } from 'express'
import { CustomHeaders } from '../common/constants/header.constants'
import { TypedConfigService } from '../config/typed-config.service'
import { LoginEventRecorder } from './login-event.recorder'
import { Context } from '../common/context/context'

interface JwtStrategyConfig {
  jwksUri: string
  audience: string
  issuer: string
}

/**
 * The user id of a verified token, for consumers that bypass Passport's validate
 * callback. Same rule as JwtStrategy.validate, so every transport resolves one user:
 * OKTA tokens carry it in `uid` (with the email in `sub`); others in `sub`.
 */
export function jwtUserId(payload: { sub?: string; cid?: unknown; uid?: unknown }): string | undefined {
  return payload.cid && payload.uid ? (payload.uid as string) : payload.sub
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name)
  private JWKS: ReturnType<typeof createRemoteJWKSet>

  constructor(
    private readonly options: JwtStrategyConfig,
    private readonly userService: UserService,
    private readonly configService: TypedConfigService,
    private readonly loginEvents: LoginEventRecorder,
  ) {
    super({
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: options.jwksUri,
      }),
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      audience: options.audience,
      issuer: options.issuer,
      algorithms: ['RS256'],
      passReqToCallback: true,
    })
    this.JWKS = createRemoteJWKSet(new URL(options.jwksUri))
    this.logger.debug('JwtStrategy initialized')
  }

  async validate(request: Request, payload: any): Promise<AuthContext> {
    // OKTA does not return the userId in access_token sub claim
    // real userId is in the uid claim and email is in the sub claim
    let userId = payload.sub
    let email = payload.email
    if (payload.cid && payload.uid) {
      userId = payload.uid
      email = payload.sub
    }
    let user = await this.userService.findOne(userId)

    if (user && !user.emailVerified && payload.email_verified) {
      await this.userService.update(user.id, {
        emailVerified: payload.email_verified,
      })
    }

    if (!user) {
      if (typeof email !== 'string' || !email.trim()) {
        throw new ForbiddenException({ message: 'Email address required for registration', code: 'email_required' })
      }
      user = await this.userService.create(
        {
          id: userId,
          name: payload.name || payload.username || 'Unknown',
          email,
          emailVerified: payload.email_verified || false,
          // Anchor the auto-created default organization to the platform's
          // default region, matching the admin-seed path in AppService. Without
          // this, OrganizationService.handleUserCreatedEvent creates the org
          // with defaultRegionId=undefined and downstream callers that read
          // organization.defaultRegionId fail for every OIDC-created user.
          defaultOrganizationDefaultRegionId: this.configService.getOrThrow('defaultRegion.id'),
        },
        Context.user({ userId, authMethod: 'jwt' }),
      )
      this.logger.debug(`Created new user with ID: ${userId}`)
    } else {
      // Only what the token states replaces stored profile data: tokens for
      // third-party MCP clients carry no profile claims, and their absence must
      // not erase a known user's email or name.
      const changes: { name?: string; email?: string } = {}
      const tokenName = payload.name || payload.username
      if (tokenName && user.name === 'Unknown') {
        changes.name = tokenName
      }
      if (typeof email === 'string' && email.trim() && user.email !== email) {
        changes.email = email
      }
      if (Object.keys(changes).length > 0) {
        await this.userService.update(user.id, changes)
        this.logger.debug(`Updated ${Object.keys(changes).join(' and ')} for existing user with ID: ${userId}`)
      }
    }

    await this.loginEvents.recordFirstUse(user.id, payload)

    const organizationId = request.get(CustomHeaders.ORGANIZATION_ID.name)

    return {
      userId: user.id,
      role: user.role,
      email: user.email,
      organizationId,
    }
  }

  /** The issuer whose tokens this strategy accepts, as tokens and the issuer's own metadata name it. */
  get issuer(): string {
    return this.options.issuer
  }

  /** Verifies a token for the API's audience, or for another one this API serves (the MCP endpoint). */
  async verifyToken(token: string, audience: string = this.options.audience): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.JWKS, {
      audience,
      issuer: this.options.issuer,
      algorithms: ['RS256'],
    })
    return payload
  }
}

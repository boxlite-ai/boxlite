/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { passportJwtSecret } from 'jwks-rsa'
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose'
import { UserService } from '../user/user.service'
import { AuthContext } from '../common/interfaces/auth-context.interface'
import { Request } from 'express'
import { CustomHeaders } from '../common/constants/header.constants'
import { TypedConfigService } from '../config/typed-config.service'
import { EmailVerificationRequiredException } from '../exceptions/email-verification-required.exception'
import { isOrganizationRegistrationRequest } from './organization-registration.guard'
import { normalizeReferralQuery } from '../organization-referral/referral-code'

interface JwtStrategyConfig {
  jwksUri: string
  audience: string
  issuer: string
}

/**
 * Auth0 database identities use the `auth0|` subject prefix. Social and
 * enterprise identities have provider-specific prefixes and stay outside this
 * database-account policy.
 *
 * Rejects with 403, not 401: the token itself is valid, so a client that
 * recovers from 401 by re-authenticating would loop forever against a state
 * only the user can clear. See EmailVerificationRequiredException.
 */
export function requireVerifiedAuth0DatabaseEmail(
  payload: Pick<JWTPayload, 'sub'> & {
    email_verified?: unknown
  },
): void {
  if (payload.sub?.startsWith('auth0|') && payload.email_verified !== true) {
    throw new EmailVerificationRequiredException()
  }
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name)
  private JWKS: ReturnType<typeof createRemoteJWKSet>

  constructor(
    private readonly options: JwtStrategyConfig,
    private readonly userService: UserService,
    private readonly configService: TypedConfigService,
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
    // Keep this before JIT user creation: an already-issued unverified Auth0
    // database token must not create local state while the Auth0 Action rollout
    // is converging.
    requireVerifiedAuth0DatabaseEmail(payload)

    // OKTA does not return the userId in access_token sub claim
    // real userId is in the uid claim and email is in the sub claim
    let userId = payload.sub
    let email = payload.email
    if (payload.cid && payload.uid) {
      userId = payload.uid
      email = payload.sub
    }
    const registrationRequest = isOrganizationRegistrationRequest(request)
    const referredCode = registrationRequest ? normalizeReferralQuery(request.query) : undefined
    const user = await this.userService.authenticate(
      {
        id: userId,
        name: payload.name || payload.username || 'Unknown',
        email: email || '',
        emailVerified: payload.email_verified === true,
        // Anchor the auto-created default organization to the platform's
        // default region, matching the admin-seed path in AppService. Without
        // this, OrganizationService.handleUserCreatedEvent creates the org
        // with defaultRegionId=undefined and downstream callers that read
        // organization.defaultRegionId fail for every OIDC-created user.
        defaultOrganizationDefaultRegionId: this.configService.getOrThrow('defaultRegion.id'),
      },
      { referredCode, confirmInvitation: registrationRequest },
    )

    const organizationId = request.get(CustomHeaders.ORGANIZATION_ID.name)

    return {
      userId: user.id,
      role: user.role,
      email: user.email,
      organizationId,
    }
  }

  async verifyToken(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.JWKS, {
      audience: this.options.audience,
      issuer: this.options.issuer,
      algorithms: ['RS256'],
    })
    // Gate direct verification consumers (Socket.IO and the WebSocket proxy),
    // which do not enter Passport's validate callback.
    requireVerifiedAuth0DatabaseEmail(payload)
    return payload
  }
}

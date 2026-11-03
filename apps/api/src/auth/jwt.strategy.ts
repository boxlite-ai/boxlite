/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
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
import { LoginEventRecorder } from './login-event.recorder'
import { Context } from '../common/context/context'

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

/** Where the Auth0 Action puts the identity of an MCP token (apps/infra/bootstrap/auth0/login-policy.js). */
const IDENTITY_CLAIMS_NAMESPACE = 'https://boxlite.ai/claims'

/**
 * The verified payload with its namespaced identity claims, when present, in
 * place of the plain `email_verified`, `email`, and `name`. A namespaced
 * verification is `true` only when it is exactly `true`, so a false or
 * malformed one denies even next to a plain `true`; a namespaced email or name
 * that is not a string rejects the token. The payload itself is left unchanged.
 */
export function withIdentityClaims<T extends Record<string, unknown>>(payload: T): T {
  const resolved: Record<string, unknown> = { ...payload }
  let namespaced = false
  const verifiedClaim = `${IDENTITY_CLAIMS_NAMESPACE}/email_verified`
  if (Object.hasOwn(payload, verifiedClaim)) {
    resolved.email_verified = payload[verifiedClaim] === true
    namespaced = true
  }
  for (const field of ['email', 'name']) {
    const claim = `${IDENTITY_CLAIMS_NAMESPACE}/${field}`
    if (!Object.hasOwn(payload, claim)) continue
    if (typeof payload[claim] !== 'string') {
      throw new UnauthorizedException(`Invalid ${field} claim`)
    }
    resolved[field] = payload[claim]
    namespaced = true
  }
  return namespaced ? (resolved as T) : payload
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

  /** The issuer whose tokens this strategy accepts, as tokens and the issuer's own metadata name it. */
  get issuer(): string {
    return this.options.issuer
  }

  async validate(request: Request, verified: any): Promise<AuthContext> {
    const payload = withIdentityClaims(verified)
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
    let user = await this.userService.findOne(userId)

    if (user && !user.emailVerified && payload.email_verified) {
      await this.userService.update(user.id, {
        emailVerified: payload.email_verified,
      })
    }

    if (!user) {
      user = await this.userService.create(
        {
          id: userId,
          name: payload.name || payload.username || 'Unknown',
          email: email || '',
          emailVerified: payload.email_verified || false,
          // Anchor the auto-created default organization to the platform's
          // default region, matching the admin-seed path in AppService. Without
          // this, OrganizationService.handleUserCreatedEvent creates the org
          // with defaultRegionId=undefined and downstream callers that read
          // organization.defaultRegionId fail for every OIDC-created user.
          defaultOrganizationDefaultRegionId: this.configService.getOrThrow('defaultRegion.id'),
        },
        Context.user(),
      )
      this.logger.debug(`Created new user with ID: ${userId}`)
    } else if (user.name === 'Unknown' || !user.email) {
      await this.userService.update(user.id, {
        name: payload.name || payload.username || 'Unknown',
        email: email || '',
      })
      this.logger.debug(`Updated name and email address for existing user with ID: ${userId}`)
    } else if (user.email !== email) {
      await this.userService.update(user.id, {
        email: email || '',
      })
      this.logger.debug(`Updated email address for existing user with ID: ${userId}`)
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

  /** Verifies a token for the API's audience, or for another one the caller serves (the MCP endpoint). */
  async verifyToken(token: string, audience: string = this.options.audience): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.JWKS, {
      audience,
      issuer: this.options.issuer,
      algorithms: ['RS256'],
    })
    const identity = withIdentityClaims(payload)
    // Gate direct verification consumers (Socket.IO, the WebSocket proxy, and
    // MCP), which do not enter Passport's validate callback.
    requireVerifiedAuth0DatabaseEmail(identity)
    return identity
  }
}

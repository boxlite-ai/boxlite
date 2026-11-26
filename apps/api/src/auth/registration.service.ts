/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable } from '@nestjs/common'
import { JWTPayload } from 'jose'
import { LegalVersionService } from '../config/legal-version.service'
import { Context } from '../common/context/context'
import { TypedConfigService } from '../config/typed-config.service'
import { UserDto } from '../user/dto/user.dto'
import { normalizeRegistrationEmail } from '../user/registration-email'
import { UserAlreadyExistsException } from '../user/user-already-exists.exception'
import { UserService } from '../user/user.service'
import { jwtUserId } from './jwt.strategy'
import { LoginEventRecorder } from './login-event.recorder'
import { registrationConsent, registrationToken } from './registration-request'
import { TurnstileService } from './turnstile.service'

@Injectable()
export class RegistrationService {
  constructor(
    private readonly users: UserService,
    private readonly turnstile: TurnstileService,
    private readonly config: TypedConfigService,
    private readonly loginEvents: LoginEventRecorder,
    private readonly legalVersions: LegalVersionService,
  ) {}

  async register(identity: JWTPayload, body: unknown): Promise<{ user: UserDto; created: boolean }> {
    const legal = this.legalVersions.getCurrent()
    const token = this.config.get('turnstile') || !legal ? registrationToken(body) : undefined
    const id = jwtUserId(identity)!
    const existing = await this.users.findOne(id)
    if (existing && (!legal || !existing.registrationConsentPending)) {
      return { user: UserDto.fromUser(existing), created: false }
    }

    const consent = legal ? registrationConsent(body, legal) : undefined
    const rawEmail = identity.cid && identity.uid ? identity.sub : identity.email
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
      throw new ForbiddenException({ code: 'email_required', message: 'Email address required for registration' })
    }
    const email = normalizeRegistrationEmail(rawEmail)
    if (token !== undefined) await this.turnstile.verify(token)

    if (existing && consent) {
      const result = await this.users.acceptPendingRegistration(id, consent, this.config.getOrThrow('defaultRegion.id'))
      if (result.accepted) await this.loginEvents.recordFirstUse(id, identity)
      return { user: UserDto.fromUser(result.user), created: false }
    }

    let user
    try {
      const name = identity.name || identity.username
      user = await this.users.create(
        {
          id,
          name: typeof name === 'string' && name ? name : 'Unknown',
          email,
          emailVerified: identity.email_verified === true,
          defaultOrganizationDefaultRegionId: this.config.getOrThrow('defaultRegion.id'),
        },
        Context.user({
          userId: id,
          authMethod: 'jwt',
          ...(identity.iat === undefined ? {} : { tokenIssuedAt: identity.iat }),
        }),
        consent,
      )
    } catch (error) {
      if (error instanceof UserAlreadyExistsException) {
        const existing = await this.users.findOne(id)
        if (existing && (!legal || !existing.registrationConsentPending)) {
          return { user: UserDto.fromUser(existing), created: false }
        }
        if (existing && consent) {
          const result = await this.users.acceptPendingRegistration(
            id,
            consent,
            this.config.getOrThrow('defaultRegion.id'),
          )
          if (result.accepted) await this.loginEvents.recordFirstUse(id, identity)
          return { user: UserDto.fromUser(result.user), created: false }
        }
      }
      throw error
    }
    await this.loginEvents.recordFirstUse(user.id, identity)
    return { user: UserDto.fromUser(user), created: true }
  }
}

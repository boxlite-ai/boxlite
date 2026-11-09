/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException, Injectable } from '@nestjs/common'
import { JWTPayload } from 'jose'
import { Context } from '../common/context/context'
import { TypedConfigService } from '../config/typed-config.service'
import { UserDto } from '../user/dto/user.dto'
import { normalizeRegistrationEmail } from '../user/registration-email'
import { UserAlreadyExistsException } from '../user/user-already-exists.exception'
import { UserService } from '../user/user.service'
import { jwtUserId } from './jwt.strategy'
import { LoginEventRecorder } from './login-event.recorder'
import { TurnstileService } from './turnstile.service'

@Injectable()
export class RegistrationService {
  constructor(
    private readonly users: UserService,
    private readonly turnstile: TurnstileService,
    private readonly config: TypedConfigService,
    private readonly loginEvents: LoginEventRecorder,
  ) {}

  async register(identity: JWTPayload, token: string): Promise<{ user: UserDto; created: boolean }> {
    const id = jwtUserId(identity)!
    const existing = await this.users.findOne(id)
    if (existing) return { user: UserDto.fromUser(existing), created: false }

    const rawEmail = identity.cid && identity.uid ? identity.sub : identity.email
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
      throw new ForbiddenException({ code: 'email_required', message: 'Email address required for registration' })
    }
    const email = normalizeRegistrationEmail(rawEmail)
    await this.turnstile.verify(token)

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
        Context.user(),
      )
    } catch (error) {
      if (error instanceof UserAlreadyExistsException) {
        const existing = await this.users.findOne(id)
        if (existing) return { user: UserDto.fromUser(existing), created: false }
      }
      throw error
    }
    await this.loginEvents.recordFirstUse(user.id, identity)
    return { user: UserDto.fromUser(user), created: true }
  }
}

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Request } from 'express'
import { JWTPayload } from 'jose'
import { ExtractJwt } from 'passport-jwt'
import { JwtStrategy, jwtUserId } from './jwt.strategy'

export interface RegistrationRequest extends Request {
  registrationIdentity: JWTPayload
}

@Injectable()
export class RegistrationJwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtStrategy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RegistrationRequest>()
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request)
    try {
      if (!token) throw new UnauthorizedException()
      const payload = await this.jwt.verifyToken(token)
      const id = jwtUserId(payload)
      if (typeof id !== 'string' || !id.trim()) throw new UnauthorizedException()
      request.registrationIdentity = payload
      return true
    } catch {
      throw new UnauthorizedException('Invalid credentials')
    }
  }
}

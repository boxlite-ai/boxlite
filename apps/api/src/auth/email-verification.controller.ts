/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  CanActivate,
  Controller,
  createParamDecorator,
  ExecutionContext,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { JwtStrategy } from './jwt.strategy'
import {
  EmailVerificationCooldownException,
  EmailVerificationPrincipal,
  EmailVerificationService,
} from './email-verification.service'

interface EmailVerificationRequest extends Request {
  emailVerificationPrincipal?: EmailVerificationPrincipal
}

const PendingPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<EmailVerificationRequest>().emailVerificationPrincipal
})

@Injectable()
export class EmailVerificationAuthGuard implements CanActivate {
  constructor(@Inject(JwtStrategy) private readonly jwtStrategy: JwtStrategy | undefined) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EmailVerificationRequest>()
    const [scheme, token] = (request.header('authorization') ?? '').split(' ')
    if (!this.jwtStrategy || scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid credentials')
    }

    try {
      const payload = await this.jwtStrategy.verifyToken(token)
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('Token subject is missing')
      }
      request.emailVerificationPrincipal = {
        subject: payload.sub,
        emailVerified: payload.email_verified === true,
      }
      return true
    } catch {
      throw new UnauthorizedException('Invalid credentials')
    }
  }
}

@ApiTags('users')
@Controller('users/me/email-verification')
@UseGuards(EmailVerificationAuthGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class EmailVerificationController {
  constructor(private readonly emailVerificationService: EmailVerificationService) {}

  @Post('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Resend the pending OIDC user email verification',
    operationId: 'resendEmailVerification',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: 'Email verification queued successfully' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'The OIDC access token is invalid or expired' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'The identity provider account is already verified' })
  @ApiResponse({ status: HttpStatus.UNPROCESSABLE_ENTITY, description: 'No usable email identity exists' })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'A verification email was requested during the cooldown window',
    headers: {
      'Retry-After': { description: 'Seconds until another request is allowed', schema: { type: 'integer' } },
    },
  })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, description: 'The identity provider rejected the request' })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'The identity provider is unavailable' })
  async resend(
    @PendingPrincipal() principal: EmailVerificationPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.emailVerificationService.resend(principal)
    } catch (error) {
      if (error instanceof EmailVerificationCooldownException) {
        response.setHeader('Retry-After', error.retryAfterSeconds.toString())
      }
      throw error
    }
  }
}

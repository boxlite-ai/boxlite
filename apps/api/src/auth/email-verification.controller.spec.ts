/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UnauthorizedException } from '@nestjs/common'
import { RequestMethod } from '@nestjs/common/enums/request-method.enum'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { EmailVerificationAuthGuard, EmailVerificationController } from './email-verification.controller'
import { EmailVerificationCooldownException } from './email-verification.service'

describe('EmailVerificationAuthGuard', () => {
  it('validates a pending OIDC token without provisioning a BoxLite user', async () => {
    const jwtStrategy = {
      verifyToken: jest.fn().mockResolvedValue({ sub: 'auth0|user-1', email_verified: false }),
    }
    const guard = new EmailVerificationAuthGuard(jwtStrategy as never)
    const request = { header: jest.fn().mockReturnValue('Bearer signed-token') }
    const context = { switchToHttp: () => ({ getRequest: () => request }) }

    await expect(guard.canActivate(context as never)).resolves.toBe(true)
    expect(jwtStrategy.verifyToken).toHaveBeenCalledWith('signed-token')
    expect(request).toMatchObject({
      emailVerificationPrincipal: { subject: 'auth0|user-1', emailVerified: false },
    })
  })

  it('maps invalid pending tokens to 401', async () => {
    const jwtStrategy = { verifyToken: jest.fn().mockRejectedValue(new Error('bad signature')) }
    const guard = new EmailVerificationAuthGuard(jwtStrategy as never)
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ header: () => 'Bearer invalid-token' }) }),
    }

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(UnauthorizedException)
  })
})

describe('EmailVerificationController', () => {
  it('publishes POST /users/me/email-verification/resend as a bodyless recovery endpoint', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, EmailVerificationController)
    const method = EmailVerificationController.prototype.resend
    const methodPath = Reflect.getMetadata(PATH_METADATA, method)

    expect(`${controllerPath}/${methodPath}`.replace(/\/{2,}/g, '/')).toBe('users/me/email-verification/resend')
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST)
  })

  it('sets Retry-After from the server cooldown', async () => {
    const cooldown = new EmailVerificationCooldownException(41)
    const service = { resend: jest.fn().mockRejectedValue(cooldown) }
    const controller = new EmailVerificationController(service as never)
    const response = { setHeader: jest.fn() }

    await expect(controller.resend({ subject: 'auth0|user-1', emailVerified: false }, response as never)).rejects.toBe(
      cooldown,
    )
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '41')
  })
})

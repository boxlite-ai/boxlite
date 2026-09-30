/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UnauthorizedException } from '@nestjs/common'
import { SignJWT } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { ADOPT_AUDIENCE, AccountLinkService } from './account-link.service'

const SECRET = 's'.repeat(32)
const PRIMARY = 'auth0|primary'
const SOCIAL = 'google-oauth2|103'

function sign(
  claims: Record<string, unknown>,
  { secret = SECRET, audience = ADOPT_AUDIENCE, issuedAt = Math.floor(Date.now() / 1000), expires = '60s' } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(secret))
}

describe('AccountLinkService.adopt', () => {
  let adopt: jest.Mock
  let service: AccountLinkService

  beforeEach(() => {
    adopt = jest.fn().mockResolvedValue(undefined)
    const config = { getOrThrow: jest.fn(() => SECRET) } as unknown as TypedConfigService
    service = new AccountLinkService(config, { adopt } as unknown as LinkedIdentityService)
  })

  it('moves the social user to the password account the Action signed for', async () => {
    const token = await sign({ sub: SOCIAL, primary_user_id: PRIMARY })

    await expect(service.adopt(token)).resolves.toEqual({ primaryUserId: PRIMARY, socialUserId: SOCIAL })
    expect(adopt).toHaveBeenCalledWith(PRIMARY, SOCIAL)
  })

  it.each([
    ['another key', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY }, { secret: 't'.repeat(32) })],
    ['another audience', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY }, { audience: 'boxlite-other' })],
    [
      'a request older than a minute',
      () =>
        sign(
          { sub: SOCIAL, primary_user_id: PRIMARY },
          { issuedAt: Math.floor(Date.now() / 1000) - 120, expires: '1h' },
        ),
    ],
    ['no primary account', () => sign({ sub: SOCIAL })],
    ['a primary that is not a password account', () => sign({ sub: SOCIAL, primary_user_id: 'github|55' })],
    ['a password account on the social side', () => sign({ sub: 'auth0|other', primary_user_id: PRIMARY })],
  ])('refuses %s and moves nothing', async (_name, token) => {
    await expect(service.adopt(await token())).rejects.toBeInstanceOf(UnauthorizedException)
    expect(adopt).not.toHaveBeenCalled()
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UnauthorizedException } from '@nestjs/common'
import { SignJWT } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { UserService } from '../user/user.service'
import { ADOPT_AUDIENCE, AccountLinkService, STATUS_AUDIENCE } from './account-link.service'

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

describe('AccountLinkService', () => {
  let adopt: jest.Mock
  let findOne: jest.Mock
  let service: AccountLinkService

  beforeEach(() => {
    adopt = jest.fn().mockResolvedValue(undefined)
    findOne = jest.fn().mockResolvedValue(null)
    const config = { getOrThrow: jest.fn(() => SECRET) } as unknown as TypedConfigService
    service = new AccountLinkService(
      config,
      { adopt } as unknown as LinkedIdentityService,
      { findOne } as unknown as UserService,
    )
  })

  describe('adopt', () => {
    it.each([
      ['a social user into a password account', SOCIAL, PRIMARY],
      ['a password account into a social one that stays', PRIMARY, SOCIAL],
      ['one social user into another', 'github|55', SOCIAL],
    ])('moves %s', async (_case, secondary, primary) => {
      const token = await sign({ sub: secondary, primary_user_id: primary })

      await expect(service.adopt(token)).resolves.toEqual({ primaryUserId: primary, secondaryUserId: secondary })
      expect(adopt).toHaveBeenCalledWith(primary, secondary)
    })

    it.each([
      ['another key', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY }, { secret: 't'.repeat(32) })],
      ['another audience', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY }, { audience: 'boxlite-other' })],
      ['a status request', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY }, { audience: STATUS_AUDIENCE })],
      [
        'a request older than a minute',
        () =>
          sign(
            { sub: SOCIAL, primary_user_id: PRIMARY },
            { issuedAt: Math.floor(Date.now() / 1000) - 120, expires: '1h' },
          ),
      ],
      ['no account to move into', () => sign({ sub: SOCIAL })],
      ['the same user on both sides', () => sign({ sub: SOCIAL, primary_user_id: SOCIAL })],
      ['a subject that is no Auth0 user id', () => sign({ sub: 'someone', primary_user_id: PRIMARY })],
      ['an account to move into that is no Auth0 user id', () => sign({ sub: SOCIAL, primary_user_id: 'primary' })],
    ])('refuses %s and moves nothing', async (_name, token) => {
      await expect(service.adopt(await token())).rejects.toBeInstanceOf(UnauthorizedException)
      expect(adopt).not.toHaveBeenCalled()
    })
  })

  describe('status', () => {
    it('answers known for a user BoxLite has', async () => {
      findOne.mockResolvedValue({ id: SOCIAL })

      await expect(service.status(await sign({ sub: SOCIAL }, { audience: STATUS_AUDIENCE }))).resolves.toEqual({
        known: true,
      })
      expect(findOne).toHaveBeenCalledWith(SOCIAL)
    })

    it('answers unknown for a user BoxLite has never seen', async () => {
      await expect(service.status(await sign({ sub: SOCIAL }, { audience: STATUS_AUDIENCE }))).resolves.toEqual({
        known: false,
      })
    })

    it.each([
      ['an adopt request', () => sign({ sub: SOCIAL, primary_user_id: PRIMARY })],
      ['another key', () => sign({ sub: SOCIAL }, { secret: 't'.repeat(32), audience: STATUS_AUDIENCE })],
      ['a subject that is no Auth0 user id', () => sign({ sub: 'someone' }, { audience: STATUS_AUDIENCE })],
    ])('refuses %s and looks nothing up', async (_name, token) => {
      await expect(service.status(await token())).rejects.toBeInstanceOf(UnauthorizedException)
      expect(findOne).not.toHaveBeenCalled()
    })
  })
})

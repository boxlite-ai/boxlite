/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Redis } from 'ioredis'
import { LoginEventRecorder } from './login-event.recorder'
import { recordBusinessEvent } from '../common/utils/business-event.util'
import { Context } from '../common/context/context'
import { ConfigService } from '@nestjs/config'

jest.mock('../common/utils/business-event.util', () => ({
  recordBusinessEvent: jest.fn(),
}))

const NOW_SECONDS = 1_700_000_000

function buildRecorder(setResult: () => Promise<string | null>) {
  const redis = { set: jest.fn(setResult) }
  const recorder = new LoginEventRecorder(redis as unknown as Redis)
  return { recorder, redis }
}

describe('LoginEventRecorder.recordFirstUse', () => {
  beforeEach(() => {
    jest.mocked(recordBusinessEvent).mockClear()
    jest.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1000)
  })

  afterEach(() => jest.restoreAllMocks())

  it('records one login the first time a token is seen, keyed until the token expires', async () => {
    const { recorder, redis } = buildRecorder(async () => 'OK')

    await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 3600 })

    expect(redis.set).toHaveBeenCalledWith(
      `business-event:user-login:user-1:${NOW_SECONDS - 10}`,
      '1',
      'EX',
      3600,
      'NX',
    )
    expect(recordBusinessEvent).toHaveBeenCalledTimes(1)
    expect(recordBusinessEvent).toHaveBeenCalledWith({
      name: 'user.login',
      outcome: 'success',
      correlationId: 'user-1',
      ctx: Context.user(),
    })
  })

  it('records nothing when the token was already seen', async () => {
    const { recorder } = buildRecorder(async () => null)

    await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 3600 })

    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  // Authentication must not depend on the event store: a Redis outage drops
  // the event, never the request.
  it('swallows a Redis failure and records nothing', async () => {
    const { recorder } = buildRecorder(async () => {
      throw new Error('connection refused')
    })

    await expect(
      recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 3600 }),
    ).resolves.toBeUndefined()
    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  it('skips tokens without an issue time or already past expiry', async () => {
    const { recorder, redis } = buildRecorder(async () => 'OK')

    await recorder.recordFirstUse('user-1', { exp: NOW_SECONDS + 3600 })
    await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 3600, exp: NOW_SECONDS })

    expect(redis.set).not.toHaveBeenCalled()
    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  it('records trusted authentication time independently of refreshed token issuance', async () => {
    const seen = new Set<string>()
    const redis = {
      set: jest.fn(async (key: string) => {
        if (seen.has(key)) return null
        seen.add(key)
        return 'OK'
      }),
    }
    const recorder = new LoginEventRecorder(
      redis as unknown as Redis,
      new ConfigService({ oidc: { authenticationTimeClaim: 'auth_time' } }),
    )
    const authTime = NOW_SECONDS - 1000
    await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 100, exp: NOW_SECONDS + 3600, auth_time: authTime })
    await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 7200, auth_time: authTime })
    const genuine = jest.mocked(recordBusinessEvent).mock.calls.filter(([event]) => event.name === 'user.login.genuine')
    expect(genuine).toEqual([
      [
        {
          name: 'user.login.genuine',
          outcome: 'success',
          correlationId: 'user-1',
          ctx: Context.user(),
          occurredAt: new Date(authTime * 1000).toISOString(),
        },
      ],
    ])
  })

  it('never substitutes issuance for missing or invalid configured authentication evidence', async () => {
    const redis = { set: jest.fn(async () => 'OK') }
    const recorder = new LoginEventRecorder(
      redis as unknown as Redis,
      new ConfigService({ oidc: { authenticationTimeClaim: 'auth_time' } }),
    )
    for (const auth_time of [undefined, '1700000000', NOW_SECONDS + 1, -1, 1.5]) {
      await recorder.recordFirstUse('user-1', { iat: NOW_SECONDS, exp: NOW_SECONDS + 3600, auth_time })
    }
    expect(jest.mocked(recordBusinessEvent).mock.calls.every(([event]) => event.name === 'user.login')).toBe(true)
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Redis } from 'ioredis'
import { LoginEventRecorder } from './login-event.recorder'
import { recordBusinessEvent } from '../common/utils/business-event.util'

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
      actorKind: 'user',
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
})

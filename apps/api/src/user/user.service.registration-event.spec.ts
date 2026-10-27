/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { UserService } from './user.service'
import { Context } from '../common/context/context'
import { PlatformReason } from '../common/context/platform-reason.enum'

describe('UserService registration events', () => {
  // Every [message, attributes] the service logged, at info or error level, in order.
  let logged: [string, Record<string, string>][]

  function makeService(transaction: jest.Mock) {
    const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) }
    const service = new UserService({} as never, eventEmitter as never, { transaction } as never)
    jest.spyOn(service as never, 'generatePrivateKey').mockResolvedValue({
      privateKey: 'private-key',
      publicKey: 'public-key',
    } as never)
    return service
  }

  const committingTransaction = () => jest.fn(async (callback) => callback({ save: jest.fn(async (entity) => entity) }))

  beforeEach(() => {
    logged = []
    const record = (message: string, attributes: Record<string, string>) => void logged.push([message, attributes])
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record as never)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(record as never)
  })

  afterEach(() => jest.restoreAllMocks())

  it('records requested then success with the context actor and no organization', async () => {
    const service = makeService(committingTransaction())

    await service.create({ id: 'user-1', name: 'User One' } as never, Context.user())

    expect(logged.map(([message]) => message)).toEqual(['user.registration requested', 'user.registration success'])
    for (const [, attributes] of logged) {
      expect(attributes).toEqual(expect.objectContaining({ 'correlation.id': 'user-1', 'actor.kind': 'user' }))
      expect(attributes).not.toHaveProperty('org.id')
    }
  })

  it('records a conflict as user_conflict instead of success, and rethrows', async () => {
    const conflict = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    const service = makeService(jest.fn().mockRejectedValue(conflict))

    await expect(service.create({ id: 'user-1', name: 'User One' } as never, Context.admin())).rejects.toBe(conflict)

    expect(logged.map(([message]) => message)).toEqual(['user.registration requested', 'user.registration exception'])
    expect(logged[1][1]).toEqual(expect.objectContaining({ 'actor.kind': 'admin', 'exception.type': 'user_conflict' }))
  })

  it('records any other failure as internal', async () => {
    const service = makeService(jest.fn().mockRejectedValue(new Error('connection reset')))

    await expect(service.create({ id: 'user-1', name: 'User One' } as never, Context.user())).rejects.toThrow()

    expect(logged[1]).toEqual([
      'user.registration exception',
      expect.objectContaining({ 'exception.type': 'internal' }),
    ])
  })

  it('records the admin seed as a platform bootstrap registration', async () => {
    const service = makeService(committingTransaction())

    await service.create({ id: 'admin', name: 'Admin' } as never, Context.platform(PlatformReason.BOOTSTRAP))

    expect(logged[1]).toEqual([
      'user.registration success',
      expect.objectContaining({ 'actor.kind': 'platform', 'event.reason': 'bootstrap' }),
    ])
  })
})

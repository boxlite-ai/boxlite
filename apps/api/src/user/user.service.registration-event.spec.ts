/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { UserService } from './user.service'
import { recordBusinessEvent } from '../common/utils/business-event.util'

jest.mock('../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

describe('UserService registration events', () => {
  function makeService(transaction: jest.Mock) {
    const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([{ id: 'org-1' }]) }
    const service = new UserService({} as never, eventEmitter as never, { transaction } as never, {} as never)
    jest.spyOn(service as never, 'generatePrivateKey').mockResolvedValue({
      privateKey: 'private-key',
      publicKey: 'public-key',
    } as never)
    return service
  }

  const committingTransaction = () => jest.fn(async (callback) => callback({ save: jest.fn(async (entity) => entity) }))

  beforeEach(() => jest.mocked(recordBusinessEvent).mockClear())

  it('records requested then success with the default organization it created', async () => {
    const service = makeService(committingTransaction())

    await service.create({ id: 'user-1', name: 'User One' } as never, 'user')

    expect(jest.mocked(recordBusinessEvent).mock.calls).toEqual([
      [{ name: 'user.registration', outcome: 'requested', correlationId: 'user-1', actorKind: 'user' }],
      [{ name: 'user.registration', outcome: 'success', correlationId: 'user-1', actorKind: 'user', orgId: 'org-1' }],
    ])
  })

  it('records an exception instead of success when the transaction fails, and rethrows', async () => {
    const conflict = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
    const service = makeService(jest.fn().mockRejectedValue(conflict))

    await expect(service.create({ id: 'user-1', name: 'User One' } as never, 'user')).rejects.toBe(conflict)

    expect(recordBusinessEvent).toHaveBeenLastCalledWith({
      name: 'user.registration',
      outcome: 'exception',
      correlationId: 'user-1',
      actorKind: 'user',
      exceptionType: 'user_conflict',
    })
    expect(recordBusinessEvent).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }))
  })

  it('records an internal exception when key generation fails, and rethrows', async () => {
    const failure = new Error('key generation failed')
    const transaction = committingTransaction()
    const service = makeService(transaction)
    jest.spyOn(service as never, 'generatePrivateKey').mockRejectedValue(failure as never)

    await expect(service.create({ id: 'user-1', name: 'User One' } as never, 'user')).rejects.toBe(failure)

    expect(transaction).not.toHaveBeenCalled()
    expect(recordBusinessEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'exception', exceptionType: 'internal' }),
    )
  })

  it('records nothing for a create that is not a registration', async () => {
    const service = makeService(committingTransaction())

    await service.create({ id: 'admin', name: 'Admin' } as never)

    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })
})

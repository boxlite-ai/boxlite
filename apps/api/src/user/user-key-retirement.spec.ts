/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Context } from '../common/context/context'
import { User } from './user.entity'
import { UserService } from './user.service'

it('creates users without generating or persisting an unused SSH key pair', async () => {
  const generate = jest.spyOn(jest.requireActual('crypto'), 'generateKeyPair')
  try {
    let persistedUser: User
    const insert = jest.fn(async (_entity, user: User) => {
      persistedUser = user
    })
    const findOneByOrFail = jest.fn(async () => persistedUser)
    const events = { emitAsync: jest.fn().mockResolvedValue([]) }
    const service = new UserService(
      {} as never,
      events as never,
      {
        transaction: async (callback) => callback({ insert, findOneByOrFail }),
      } as never,
    )

    const user = await service.create({ id: 'user-1', name: 'User', email: 'user@gmail.com' }, Context.user())

    expect(generate).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(User, user)
    expect(user).not.toHaveProperty('keyPair')
    expect(user.publicKeys).toEqual([])
    expect(events.emitAsync).toHaveBeenCalledTimes(1)
  } finally {
    generate.mockRestore()
  }
})

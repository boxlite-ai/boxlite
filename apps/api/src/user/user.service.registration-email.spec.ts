/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Context } from '../common/context/context'
import { PlatformReason } from '../common/context/platform-reason.enum'
import { User } from './user.entity'
import { UserService } from './user.service'

function makeService() {
  const save = jest.fn(async (user) => user)
  let insertedUser: User
  const insert = jest.fn(async (_entity, user: User) => {
    insertedUser = user
  })
  const findOneByOrFail = jest.fn(async () => insertedUser)
  const repository = { findOne: jest.fn().mockResolvedValue(null), save }
  const transaction = jest.fn(async (callback) => callback({ insert, findOneByOrFail }))
  const events = { emitAsync: jest.fn().mockResolvedValue([]) }
  const service = new UserService(repository as never, events as never, { transaction } as never, {} as never)

  return { service, repository, insert, save, transaction, events }
}

afterEach(() => jest.restoreAllMocks())

describe('UserService registration email policy', () => {
  it.each(['new@mailinator.com', 'NEW@MAILINATOR.COM', 'new@sub.mailinator.com', 'new@sub.drtall.com'])(
    'rejects %s before registration side effects',
    async (email) => {
      const { service, transaction, events } = makeService()

      await expect(service.create({ id: 'new-user', name: 'New User', email }, Context.user())).rejects.toMatchObject({
        status: 403,
        response: { code: 'disposable_email' },
      })
      expect(transaction).not.toHaveBeenCalled()
      expect(events.emitAsync).not.toHaveBeenCalled()
    },
  )

  it('applies the same domain policy to administrator-created users', async () => {
    const { service, transaction, events } = makeService()

    await expect(
      service.create({ id: 'admin-created', name: 'New User', email: 'new@mailinator.com' }, Context.admin()),
    ).rejects.toMatchObject({ status: 403, response: { code: 'disposable_email' } })
    expect(transaction).not.toHaveBeenCalled()
    expect(events.emitAsync).not.toHaveBeenCalled()
  })

  it('rejects malformed email before applying the disposable domain policy', async () => {
    const { service, transaction } = makeService()

    await expect(
      service.create({ id: 'new-user', name: 'New User', email: 'invalid local@mailinator.com' }, Context.user()),
    ).rejects.toMatchObject({ status: 400, response: { code: 'invalid_email' } })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('persists the normalized address for an allowed provider', async () => {
    const { service, insert, events } = makeService()

    const user = await service.create({ id: 'new-user', name: 'New User', email: '  New@GMAIL.COM  ' }, Context.user())

    expect(user.email).toBe('new@gmail.com')
    expect(insert).toHaveBeenCalledWith(User, expect.objectContaining({ email: 'new@gmail.com' }))
    expect(events.emitAsync).toHaveBeenCalledTimes(1)
  })

  it('preserves the email-free bootstrap administrator', async () => {
    const { service, insert } = makeService()

    await expect(
      service.create({ id: 'admin', name: 'Admin' }, Context.platform(PlatformReason.BOOTSTRAP)),
    ).resolves.toMatchObject({ id: 'admin' })

    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('preserves email updates on an existing account', async () => {
    const { service, repository, save } = makeService()
    repository.findOne.mockResolvedValue({ id: 'existing', email: 'existing@gmail.com' })

    await expect(service.update('existing', { email: 'existing@mailinator.com' })).resolves.toMatchObject({
      email: 'existing@mailinator.com',
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ email: 'existing@mailinator.com' }))
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { JwtStrategy } from '../auth/jwt.strategy'
import { LoginEventRecorder } from '../auth/login-event.recorder'
import { Context } from '../common/context/context'
import { PlatformReason } from '../common/context/platform-reason.enum'
import { TypedConfigService } from '../config/typed-config.service'
import { UserService } from './user.service'

function makeService() {
  const save = jest.fn(async (user) => user)
  const repository = { findOne: jest.fn().mockResolvedValue(null), save }
  const transaction = jest.fn(async (callback) => callback({ save }))
  const events = { emitAsync: jest.fn().mockResolvedValue([]) }
  const service = new UserService(repository as never, events as never, { transaction } as never)
  const generateKey = jest.spyOn(service as never, 'generatePrivateKey').mockResolvedValue({
    privateKey: 'private-key',
    publicKey: 'public-key',
  } as never)

  return { service, repository, save, transaction, events, generateKey }
}

afterEach(() => jest.restoreAllMocks())

describe('UserService registration email policy', () => {
  it.each(['new@mailinator.com', 'NEW@MAILINATOR.COM', 'new@sub.mailinator.com', 'new@sub.drtall.com'])(
    'rejects %s before registration side effects',
    async (email) => {
      const { service, generateKey, transaction, events } = makeService()

      await expect(service.create({ id: 'new-user', name: 'New User', email }, Context.user())).rejects.toMatchObject({
        status: 403,
        response: { code: 'disposable_email' },
      })

      expect(generateKey).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
      expect(events.emitAsync).not.toHaveBeenCalled()
    },
  )

  it('applies the same domain policy to administrator-created users', async () => {
    const { service, generateKey, transaction, events } = makeService()

    await expect(
      service.create({ id: 'admin-created', name: 'New User', email: 'new@mailinator.com' }, Context.admin()),
    ).rejects.toMatchObject({ status: 403, response: { code: 'disposable_email' } })

    expect(generateKey).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(events.emitAsync).not.toHaveBeenCalled()
  })

  it('rejects malformed email before applying the disposable domain policy', async () => {
    const { service, generateKey, transaction } = makeService()

    await expect(
      service.create({ id: 'new-user', name: 'New User', email: 'invalid local@mailinator.com' }, Context.user()),
    ).rejects.toMatchObject({ status: 400, response: { code: 'invalid_email' } })

    expect(generateKey).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('persists the normalized address for an allowed provider', async () => {
    const { service, save, events } = makeService()

    const user = await service.create({ id: 'new-user', name: 'New User', email: '  New@GMAIL.COM  ' }, Context.user())

    expect(user.email).toBe('new@gmail.com')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@gmail.com' }))
    expect(events.emitAsync).toHaveBeenCalledTimes(1)
  })

  it('preserves the email-free bootstrap administrator', async () => {
    const { service, save } = makeService()

    await expect(
      service.create({ id: 'admin', name: 'Admin' }, Context.platform(PlatformReason.BOOTSTRAP)),
    ).resolves.toMatchObject({ id: 'admin' })

    expect(save).toHaveBeenCalledTimes(1)
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

describe('OIDC first-use registration email policy', () => {
  it.each([
    ['auth0|new-user', 'new@drtall.com'],
    ['auth0|new-user', 'new@emailkeep.com'],
    ['google-oauth2|new-user', 'new@mailinator.com'],
    ['github|new-user', 'new@mailinator.com'],
    ['enterprise|new-user', 'new@mailinator.com'],
  ])('rejects %s with %s before creating local state', async (sub, email) => {
    const { service, generateKey, transaction, events } = makeService()
    const config = {
      getOrThrow: jest.fn().mockReturnValue('default-region'),
    } as unknown as TypedConfigService
    const loginEvents = { recordFirstUse: jest.fn() } as unknown as LoginEventRecorder
    const strategy = new JwtStrategy(
      { issuer: 'https://issuer.example.com', jwksUri: 'https://issuer.example.com/jwks', audience: 'boxlite' },
      service,
      config,
      loginEvents,
    )
    const request = { get: jest.fn() } as unknown as Request

    await expect(strategy.validate(request, { sub, email, email_verified: true })).rejects.toMatchObject({
      status: 403,
      response: { code: 'disposable_email' },
    })

    expect(generateKey).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(events.emitAsync).not.toHaveBeenCalled()
    expect(loginEvents.recordFirstUse).not.toHaveBeenCalled()
  })
})

/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('Organization invitation lifetime configuration', () => {
  const key = 'ORGANIZATION_INVITATION_TTL_SECONDS'
  let original: string | undefined

  beforeEach(() => {
    original = process.env[key]
    delete process.env[key]
    jest.resetModules()
  })

  afterEach(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
    jest.resetModules()
  })

  const load = () => (require('./configuration') as typeof import('./configuration')).configuration

  it('defaults to seven days', () => {
    expect(load()).toHaveProperty('organizationInvitation.ttlSeconds', 604800)
  })

  it('reads a configured lifetime in seconds', () => {
    process.env[key] = '3600'
    expect(load()).toHaveProperty('organizationInvitation.ttlSeconds', 3600)
  })

  it.each(['0', '-1', '1.5', '1h', '1e3', 'Infinity', '9007199254740991'])(
    'rejects invalid lifetime %s at startup',
    (value) => {
      process.env[key] = value
      expect(load).toThrow(/ORGANIZATION_INVITATION_TTL_SECONDS/)
    },
  )
})

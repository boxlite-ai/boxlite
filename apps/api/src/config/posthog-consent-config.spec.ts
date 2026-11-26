/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
describe('PostHog consent backlog configuration', () => {
  const key = 'POSTHOG_CONSENT_BACKLOG_LIMIT'
  const load = (value?: string) => {
    const env = { ...process.env }
    if (value === undefined) delete env[key]
    else env[key] = value
    jest.replaceProperty(process, 'env', env)
    let limit: number
    jest.isolateModules(() => {
      limit = (require('./configuration') as typeof import('./configuration')).configuration.posthog.consentBacklogLimit
    })
    return limit!
  }

  afterEach(() => jest.restoreAllMocks())

  it('defaults to 1000 when the stage omits the setting', () => expect(load()).toBe(1000))
  it('reads an explicit stage value', () => expect(load('250')).toBe(250))
  it.each(['0', '-1', '2.5', '3x', '9007199254740992'])('rejects %s at startup', (value) => {
    expect(() => load(value)).toThrow(key)
  })
})

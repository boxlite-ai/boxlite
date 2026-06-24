import { RESERVED_ENV_MESSAGE, hasReservedEnv, hasReservedEnvInBody } from './reserved-env.util'

describe('reserved env validation', () => {
  it('detects BOXLITE_EXECUTOR in create or exec env payloads', () => {
    expect(hasReservedEnv({ BOXLITE_EXECUTOR: 'guest' })).toBe(true)
    expect(hasReservedEnvInBody({ env: { BOXLITE_EXECUTOR: 'guest' } })).toBe(true)
  })

  it('allows ordinary env payloads and malformed env shapes', () => {
    expect(hasReservedEnv({ NODE_ENV: 'production' })).toBe(false)
    expect(hasReservedEnvInBody({ env: { NODE_ENV: 'production' } })).toBe(false)
    expect(hasReservedEnvInBody({ env: ['BOXLITE_EXECUTOR=guest'] })).toBe(false)
    expect(RESERVED_ENV_MESSAGE).toContain('BOXLITE_EXECUTOR')
  })
})

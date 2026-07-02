import { describe, expect, it } from 'vitest'
import { getRestApiUrl, resolveEnvironment } from './environment'

describe('resolveEnvironment', () => {
  it('maps known hosts to their environment', () => {
    expect(resolveEnvironment('localhost')).toBe('local')
    expect(resolveEnvironment('127.0.0.1')).toBe('local')
    expect(resolveEnvironment('dev.boxlite.ai')).toBe('development')
    expect(resolveEnvironment('app.boxlite.ai')).toBe('production')
  })

  it('defaults unrecognised hosts to production', () => {
    expect(resolveEnvironment('something.example.com')).toBe('production')
  })
})

describe('getRestApiUrl', () => {
  const fallback = 'http://fallback.local/api'

  it('uses a pinned URL for environments that define one', () => {
    expect(getRestApiUrl(fallback, 'dev.boxlite.ai')).toBe('https://dev.boxlite.ai/api')
    expect(getRestApiUrl(fallback, 'app.boxlite.ai')).toBe('https://api.boxlite.ai/api')
  })

  it('falls back when the environment has no pinned URL (e.g. local)', () => {
    expect(getRestApiUrl(fallback, 'localhost')).toBe(fallback)
  })
})

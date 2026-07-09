import { describe, expect, it } from 'vitest'
import { getQuickstartRestApiUrl, getRestApiUrl, resolveEnvironment } from './environment'

describe('resolveEnvironment', () => {
  it('maps known hosts to their environment', () => {
    expect(resolveEnvironment('localhost')).toBe('local')
    expect(resolveEnvironment('127.0.0.1')).toBe('local')
    expect(resolveEnvironment('dev.boxlite.ai')).toBe('development')
    expect(resolveEnvironment('app.boxlite.ai')).toBe('production')
  })

  it('uses the OIDC issuer before the browser hostname', () => {
    expect(resolveEnvironment('localhost', 'https://auth.dev.boxlite.ai')).toBe('development')
    expect(resolveEnvironment('localhost', 'https://auth.boxlite.ai')).toBe('production')
    expect(resolveEnvironment('localhost', 'http://localhost:25556/dex')).toBe('local')
  })

  it('defaults unrecognised hosts to production', () => {
    expect(resolveEnvironment('something.example.com')).toBe('production')
  })
})

describe('getRestApiUrl', () => {
  const fallback = 'http://fallback.local/api'

  it('uses a pinned URL for environments that define one', () => {
    expect(getRestApiUrl(fallback, 'dev.boxlite.ai')).toBe('https://api.dev.boxlite.ai')
    expect(getRestApiUrl(fallback, 'app.boxlite.ai')).toBe('https://api.boxlite.ai')
    expect(getRestApiUrl(fallback, 'localhost', 'https://auth.dev.boxlite.ai')).toBe('https://api.dev.boxlite.ai')
    expect(getRestApiUrl(fallback, 'localhost', 'https://auth.boxlite.ai')).toBe('https://api.boxlite.ai')
  })

  it('falls back when the environment has no pinned URL (e.g. local)', () => {
    expect(getRestApiUrl(fallback, 'localhost')).toBe(fallback)
  })
})

describe('getQuickstartRestApiUrl', () => {
  it('prefers the API canonical base returned by /config', () => {
    expect(
      getQuickstartRestApiUrl({
        apiUrl: 'https://dev.boxlite.ai/api',
        oidc: { issuer: 'https://auth.dev.boxlite.ai' },
        publicEndpoints: {
          api: {
            canonicalBaseUrl: 'https://api.dev.boxlite.ai',
          },
        },
      }),
    ).toBe('https://api.dev.boxlite.ai')
  })

  it('falls back to host and issuer detection when /config has no public endpoint contract', () => {
    expect(getQuickstartRestApiUrl({ apiUrl: 'https://fallback.local/api', oidc: { issuer: 'https://auth.dev.boxlite.ai' } }))
      .toBe('https://api.dev.boxlite.ai')
  })
})

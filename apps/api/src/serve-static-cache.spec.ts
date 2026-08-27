import { dashboardStaticCacheControl, setDashboardStaticHeaders } from './serve-static-cache'

describe('dashboardStaticCacheControl', () => {
  it('caches content-hashed assets forever (immutable)', () => {
    expect(dashboardStaticCacheControl('/srv/dashboard/assets/index-C8CfaZCN.js')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(dashboardStaticCacheControl('/srv/dashboard/assets/index-Dt9Taow4.css')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(dashboardStaticCacheControl('/srv/dashboard/auth0/ibm-plex-mono-400-ba204497.woff2')).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('never long-caches the HTML shell (must point at the current bundle)', () => {
    expect(dashboardStaticCacheControl('/srv/dashboard/index.html')).toBe('no-cache')
  })

  it('revalidates other top-level static files', () => {
    expect(dashboardStaticCacheControl('/srv/dashboard/favicon.ico')).toBe('public, max-age=0, must-revalidate')
  })
})

describe('setDashboardStaticHeaders', () => {
  it('writes the resolved Cache-Control onto the response', () => {
    const headers: Record<string, string> = {}
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) }

    setDashboardStaticHeaders(res, '/srv/dashboard/assets/index-C8CfaZCN.js')

    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
  })

  it('allows Auth0 pages to load immutable branding assets without weakening other static responses', () => {
    const auth0Headers: Record<string, string> = {}
    const ordinaryHeaders: Record<string, string> = {}

    setDashboardStaticHeaders(
      { setHeader: (name: string, value: string) => (auth0Headers[name] = value) },
      '/srv/dashboard/auth0/ibm-plex-mono-400-ba204497.woff2',
    )
    setDashboardStaticHeaders(
      { setHeader: (name: string, value: string) => (ordinaryHeaders[name] = value) },
      '/srv/dashboard/favicon.ico',
    )

    expect(auth0Headers).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    })
    expect(ordinaryHeaders).toEqual({ 'Cache-Control': 'public, max-age=0, must-revalidate' })
  })
})

import { dashboardStaticCacheControl, setDashboardStaticHeaders } from './serve-static-cache'

describe('dashboardStaticCacheControl', () => {
  it('caches content-hashed assets forever (immutable)', () => {
    expect(dashboardStaticCacheControl('/srv/dashboard/assets/index-C8CfaZCN.js')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(dashboardStaticCacheControl('/srv/dashboard/assets/index-Dt9Taow4.css')).toBe(
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
})

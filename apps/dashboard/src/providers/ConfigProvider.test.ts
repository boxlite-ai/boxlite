// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { resolveDashboardApiUrl } from './ConfigProvider'

describe('resolveDashboardApiUrl', () => {
  it('keeps canonical api hosts unprefixed', () => {
    expect(resolveDashboardApiUrl('https://api.dev.boxlite.ai', 'https://dev.boxlite.ai')).toBe(
      'https://api.dev.boxlite.ai',
    )
    expect(resolveDashboardApiUrl('https://api.app.boxlite.ai', 'https://app.boxlite.ai')).toBe(
      'https://api.app.boxlite.ai',
    )
  })

  it('preserves explicit legacy /api bases', () => {
    expect(resolveDashboardApiUrl('https://dev.boxlite.ai/api', 'https://dev.boxlite.ai')).toBe(
      'https://dev.boxlite.ai/api',
    )
  })

  it('keeps stale dashboard-origin overrides working by adding /api', () => {
    expect(resolveDashboardApiUrl('https://dev.boxlite.ai', 'https://dev.boxlite.ai')).toBe(
      'https://dev.boxlite.ai/api',
    )
  })

  it('defaults local dashboard traffic to same-origin /api', () => {
    expect(resolveDashboardApiUrl(undefined, 'http://localhost:3000')).toBe('http://localhost:3000/api')
  })
})

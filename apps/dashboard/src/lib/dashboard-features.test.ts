import { describe, expect, it } from 'vitest'
import { getSandboxContentTabs, isDashboardVncEnabled } from './dashboard-features'

describe('dashboard feature gates', () => {
  it('fails closed when the VNC feature flag is unavailable or disabled', () => {
    expect(isDashboardVncEnabled(undefined)).toBe(false)
    expect(isDashboardVncEnabled(false)).toBe(false)
    expect(isDashboardVncEnabled(true)).toBe(true)
  })

  it('only exposes the VNC tab when VNC is enabled', () => {
    expect(getSandboxContentTabs({ experimentsEnabled: false, vncEnabled: false })).toEqual(['overview', 'terminal'])
    expect(getSandboxContentTabs({ experimentsEnabled: false, vncEnabled: true })).toEqual([
      'overview',
      'terminal',
      'vnc',
    ])
  })

  it('keeps experiment tabs independent from the VNC feature gate', () => {
    expect(getSandboxContentTabs({ experimentsEnabled: true, vncEnabled: false })).toEqual([
      'overview',
      'logs',
      'traces',
      'metrics',
      'spending',
      'terminal',
    ])
  })
})

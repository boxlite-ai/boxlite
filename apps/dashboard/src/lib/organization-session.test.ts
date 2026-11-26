import { describe, expect, it } from 'vitest'
import { organizationSwitchPath } from './organization-session'
describe('Organization switch routing', () => {
  it('keeps the coupon link when switching organizations from Wallet', () => {
    expect(organizationSwitchPath('/dashboard/billing', '?tab=wallet&code=ABCD-EFGH&session_id=old')).toBe(
      '/dashboard/billing?tab=wallet&code=ABCD-EFGH',
    )
  })
  it('drops checkout details when switching from Wallet without a coupon', () => {
    expect(organizationSwitchPath('/dashboard/billing', '?tab=wallet&session_id=old')).toBe('/dashboard/boxes')
  })
  it.each([
    '/dashboard/boxes',
    '/dashboard/images',
    '/dashboard/ci',
    '/dashboard/apps',
    '/dashboard/volumes',
    '/dashboard/images/registries',
  ])('keeps list %s', (path) => {
    expect(organizationSwitchPath(path)).toBe(path)
  })
  it.each([
    ['/dashboard/boxes/old-box/terminal', '/dashboard/boxes'],
    ['/dashboard/images/old-image', '/dashboard/images'],
    ['/dashboard/ci/old-run', '/dashboard/ci'],
    ['/dashboard/apps/old-app', '/dashboard/apps'],
    ['/dashboard/settings', '/dashboard/boxes'],
    ['/dashboard/billing', '/dashboard/boxes'],
  ])('removes organization-specific context from %s', (path, target) => {
    expect(organizationSwitchPath(path)).toBe(target)
  })
})

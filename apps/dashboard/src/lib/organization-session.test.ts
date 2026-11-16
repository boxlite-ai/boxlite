import { describe, expect, it } from 'vitest'
import { organizationSwitchPath } from './organization-session'
describe('Organization switch routing', () => {
  it.each([
    '/dashboard/boxes',
    '/dashboard/images',
    '/dashboard/ci',
    '/dashboard/volumes',
    '/dashboard/images/registries',
  ])('keeps list %s', (path) => {
    expect(organizationSwitchPath(path)).toBe(path)
  })
  it.each([
    ['/dashboard/boxes/old-box/terminal', '/dashboard/boxes'],
    ['/dashboard/images/old-image', '/dashboard/images'],
    ['/dashboard/ci/old-run', '/dashboard/ci'],
    ['/dashboard/settings', '/dashboard/boxes'],
    ['/dashboard/billing', '/dashboard/boxes'],
  ])('removes organization-specific context from %s', (path, target) => {
    expect(organizationSwitchPath(path)).toBe(target)
  })
})

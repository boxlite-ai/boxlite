import { describe, expect, it } from 'vitest'
import { resolveSelectedOrganizationId } from './organization-selection'

describe('organization selection', () => {
  const organizations = [
    {
      id: 'team-org',
      name: 'Team Org',
      isDefaultForAuthenticatedUser: false,
    },
    {
      id: 'default-org',
      name: 'Default Organization',
      isDefaultForAuthenticatedUser: true,
    },
  ] as never

  it('prefers a still-accessible stored organization selection', () => {
    expect(resolveSelectedOrganizationId(organizations, 'team-org')).toBe('team-org')
  })

  it('falls back to the authenticated user default organization', () => {
    expect(resolveSelectedOrganizationId(organizations, 'deleted-org')).toBe('default-org')
    expect(resolveSelectedOrganizationId(organizations, null)).toBe('default-org')
  })
})

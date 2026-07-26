import { describe, expect, it } from 'vitest'
import { ORGANIZATION_ROLE_PERMISSIONS_GROUPS } from './OrganizationPermissionsGroups'

describe('Organization role permission catalog', () => {
  it('offers only currently supported resource groups', () => {
    expect(ORGANIZATION_ROLE_PERMISSIONS_GROUPS).toEqual([
      {
        name: 'Boxes',
        permissions: ['write:boxes', 'delete:boxes'],
      },
    ])
  })
})

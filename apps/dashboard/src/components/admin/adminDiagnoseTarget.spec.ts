/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import type { OwnerGroup } from './adminHelpers'
import { createOwnerGroupDiagnoseTarget } from './adminDiagnoseTarget'

function ownerGroup(partial: Partial<OwnerGroup>): OwnerGroup {
  return {
    organizationId: 'org-1',
    owner: {
      userId: 'user-1',
      name: 'Brian Luo',
      email: 'brian@example.com',
      orgName: 'Brian Personal',
      personal: true,
    },
    boxes: [],
    breakdown: [],
    ...partial,
  }
}

describe('createOwnerGroupDiagnoseTarget', () => {
  it('creates a user diagnosis target for personal owner groups with a user id', () => {
    const target = createOwnerGroupDiagnoseTarget(ownerGroup({ boxes: [{ id: 'box-1' } as never] }))

    expect(target).toMatchObject({
      kind: 'user',
      title: 'Diagnose user',
      params: {
        orgId: 'org-1',
        userId: 'user-1',
      },
    })
    expect(target.details).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'user' })]))
  })

  it('creates an org diagnosis target for team owner groups', () => {
    const target = createOwnerGroupDiagnoseTarget(
      ownerGroup({
        organizationId: 'org-team',
        owner: {
          userId: 'owner-user-1',
          name: 'Platform Team',
          email: 'owner@example.com',
          orgName: 'Platform Team',
          personal: false,
        },
      }),
    )

    expect(target).toMatchObject({
      kind: 'org',
      title: 'Diagnose org',
      params: {
        orgId: 'org-team',
      },
    })
    expect(target.params).not.toHaveProperty('userId')
    expect(target.details).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'org' })]))
  })
})

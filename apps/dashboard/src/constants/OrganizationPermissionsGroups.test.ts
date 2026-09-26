/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'

import { CREATE_API_KEY_PERMISSIONS_GROUPS } from './CreateApiKeyPermissionsGroups'
import { ORGANIZATION_ROLE_PERMISSIONS_GROUPS } from './OrganizationPermissionsGroups'

const PERMISSION_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<{ name: string; permissions: string[] }>]> = [
  ['ORGANIZATION_ROLE_PERMISSIONS_GROUPS', ORGANIZATION_ROLE_PERMISSIONS_GROUPS],
  ['CREATE_API_KEY_PERMISSIONS_GROUPS', CREATE_API_KEY_PERMISSIONS_GROUPS],
]

describe('permission groups', () => {
  /**
   * `*:templates` names the image/template subsystem removed upstream: no API
   * route enforces those scopes any more, so a group offering them grants
   * nothing. The group that offered them here was labelled "Images", which is
   * the name the image catalog will want once `*:images` exists — so the next
   * person to add an Images group has to point it at the new scopes rather
   * than resurrect these. Both group files are checked because they are
   * edited as a pair and only one of them carried the residue.
   */
  it('offer no permission backed by the removed template subsystem', () => {
    const offenders = PERMISSION_GROUPS.flatMap(([source, groups]) =>
      groups.flatMap((group) =>
        group.permissions
          .filter((permission) => permission.endsWith(':templates'))
          .map((permission) => `${source} · ${group.name}: ${permission}`),
      ),
    )

    expect(
      offenders,
      `These groups offer scopes no route enforces. An Images group belongs on *:images:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

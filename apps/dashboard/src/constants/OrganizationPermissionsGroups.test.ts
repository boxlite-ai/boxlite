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
   * the name the image catalog wanted — so the Images group below had to be
   * built on `*:images` rather than resurrect these. Both group files are
   * checked because they are edited as a pair and only one of them carried the
   * residue.
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

  /**
   * Both files, because they are the pair a reader assumes is in sync and were
   * not: the role file carried an Images group that granted `*:templates`, and
   * the API key file had no Images group at all. A key that can read the
   * catalog but cannot be granted that scope is the failure this holds off.
   */
  it.each(PERMISSION_GROUPS)('offer the catalog scopes in %s', (_source, groups) => {
    const images = groups.find((group) => group.name === 'Images')

    expect(images?.permissions).toEqual(['read:images', 'delete:images'])
  })

  /**
   * There is no `write:images` scope: an image enters the catalog by being
   * used, so creating a box is what writes it. Offering a write here would
   * name a route that does not exist.
   */
  it('offer no write scope for images', () => {
    const offenders = PERMISSION_GROUPS.flatMap(([source, groups]) =>
      groups.flatMap((group) =>
        group.permissions.filter((permission) => permission === 'write:images').map(() => source),
      ),
    )

    expect(offenders).toEqual([])
  })
})

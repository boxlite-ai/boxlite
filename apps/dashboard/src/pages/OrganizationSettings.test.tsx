// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import OrganizationSettings from './OrganizationSettings'

// A password account after a social login was linked into it: its own
// organization is the default, and the one the social login created arrived
// with the moved membership.
const LINKED_ORGANIZATIONS = [
  { id: 'org-password', name: 'Ada Lovelace', isDefaultForAuthenticatedUser: true },
  { id: 'org-google', name: '', isDefaultForAuthenticatedUser: false },
]

const mocks = vi.hoisted(() => ({
  onSelectOrganization: vi.fn(),
  organizations: [] as { id: string; name: string; isDefaultForAuthenticatedUser: boolean }[],
}))

vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ axiosInstance: { patch: vi.fn() } }) }))
vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ organizations: mocks.organizations, refreshOrganizations: vi.fn() }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: mocks.organizations[0],
    authenticatedUserOrganizationMember: null,
    onSelectOrganization: mocks.onSelectOrganization,
  }),
}))

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  mocks.onSelectOrganization.mockReset().mockResolvedValue(true)
  mocks.organizations = LINKED_ORGANIZATIONS
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function organizationRows() {
  return Array.from(container.querySelectorAll('[data-organization-id]')) as HTMLElement[]
}

describe('OrganizationSettings', () => {
  it('lists every organization the user belongs to, marking the one open', async () => {
    await act(async () => root.render(<OrganizationSettings />))

    const rows = organizationRows()
    expect(rows.map((row) => row.dataset.organizationId)).toEqual(['org-password', 'org-google'])
    expect(rows[0].textContent).toContain('Ada Lovelace')
    expect(rows[0].textContent).toContain('Current')
    expect(rows[0].querySelector('button')).toBeNull()
    expect(rows[1].textContent).toContain('Default Organization')
  })

  it('keeps the page as it was for someone in one organization', async () => {
    mocks.organizations = LINKED_ORGANIZATIONS.slice(0, 1)

    await act(async () => root.render(<OrganizationSettings />))

    expect(organizationRows()).toEqual([])
    expect(container.textContent).not.toContain('Your Organizations')
    expect(container.textContent).toContain('Organization Details')
  })

  it('opens another organization from its row', async () => {
    await act(async () => root.render(<OrganizationSettings />))

    const button = organizationRows()[1].querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('Switch')
    await act(async () => button.click())

    expect(mocks.onSelectOrganization).toHaveBeenCalledWith('org-google')
  })
})

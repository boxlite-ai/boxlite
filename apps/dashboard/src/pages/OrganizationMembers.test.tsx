// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import OrganizationMembers from './OrganizationMembers'

// Hooks hand out stable references, as the real providers do; fresh objects on
// every render would re-fire the page's effects forever.
const mocks = vi.hoisted(() => {
  const createOrganizationInvitation = vi.fn(async () => ({ data: {} }))
  return {
    createOrganizationInvitation,
    api: {
      organizationsApi: {
        listOrganizationInvitations: async () => ({ data: [] }),
        createOrganizationInvitation,
      },
    },
    organizations: { refreshOrganizations: async () => undefined },
    selectedOrganization: {
      selectedOrganization: { id: 'org-1' },
      organizationMembers: [],
      refreshOrganizationMembers: async () => [],
      authenticatedUserOrganizationMember: { userId: 'user-1', role: 'owner' },
    },
    auth: { user: { profile: { sub: 'user-1' } } },
  }
})

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => mocks.organizations }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selectedOrganization }))
vi.mock('react-oidc-context', () => ({ useAuth: () => mocks.auth }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page chrome reads the banner context, which this test does not mount.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}))

describe('OrganizationMembers', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Pagination asks for the viewport size; jsdom has no matchMedia.
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as never
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  it('invites by email alone, as an owner with no role assignments', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<OrganizationMembers />)
    })

    const openDialog = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Invite Member'))
    await act(async () => openDialog?.click())

    const email = document.querySelector<HTMLInputElement>('#email')
    expect(email).toBeTruthy()
    // React tracks the value through the native setter, so assign it that way before firing input.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(email, 'new@example.com')
      email?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      document
        .querySelector('#invitation-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )

    expect(mocks.createOrganizationInvitation).toHaveBeenCalledWith('org-1', {
      email: 'new@example.com',
      role: 'owner',
      assignedRoleIds: [],
    })
  })
})

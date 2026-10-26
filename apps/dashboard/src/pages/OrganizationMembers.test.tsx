// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import OrganizationMembers from './OrganizationMembers'

// Hooks hand out stable references, as the real providers do; fresh objects on
// every render would re-fire the page's effects forever.
const mocks = vi.hoisted(() => {
  const createOrganizationInvitation = vi.fn(async () => ({ data: {} }))
  const cancelOrganizationInvitation = vi.fn(async () => undefined)
  const listOrganizationInvitations = vi.fn(async () => ({ data: [] as unknown[] }))
  return {
    createOrganizationInvitation,
    cancelOrganizationInvitation,
    listOrganizationInvitations,
    handleApiError: vi.fn(),
    success: vi.fn(),
    api: {
      organizationsApi: {
        createOrganizationInvitation,
        cancelOrganizationInvitation,
        listOrganizationInvitations,
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
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: vi.fn() } }))
vi.mock('@/lib/error-handling', () => ({ handleApiError: mocks.handleApiError }))
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

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createOrganizationInvitation.mockResolvedValue({ data: {} })
    mocks.cancelOrganizationInvitation.mockResolvedValue(undefined)
    mocks.listOrganizationInvitations.mockResolvedValue({
      data: [
        {
          id: 'expired-1',
          email: 'expired@example.com',
          role: 'member',
          status: 'pending',
          invitedBy: 'owner@example.com',
          expiresAt: new Date(0),
          assignedRoles: [{ id: 'role-1' }],
        },
      ],
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function renderPage() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<OrganizationMembers />)
    })
  }

  async function resendExpiredInvitation() {
    const row = [...document.querySelectorAll('tbody tr')].find((item) =>
      item.textContent?.includes('expired@example.com'),
    )
    const trigger = row?.querySelector('button')
    expect(trigger).toBeTruthy()
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const resend = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Resend',
    )
    expect(resend).toBeTruthy()
    await act(async () => resend?.click())
  }

  it('invites by email alone, as an owner with no role assignments', async () => {
    await renderPage()

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

  it('resends an expired invitation with the same permissions and a fresh default lifetime before removing the old row', async () => {
    await renderPage()
    await resendExpiredInvitation()
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledWith('org-1', {
      email: 'expired@example.com',
      role: 'member',
      assignedRoleIds: ['role-1'],
    })
    expect(mocks.cancelOrganizationInvitation).toHaveBeenCalledWith('org-1', 'expired-1')
    expect(mocks.createOrganizationInvitation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cancelOrganizationInvitation.mock.invocationCallOrder[0],
    )
    expect(mocks.listOrganizationInvitations).toHaveBeenCalledTimes(2)
  })

  it('keeps the expired invitation when replacement creation fails', async () => {
    const error = new Error('Creation failed')
    mocks.createOrganizationInvitation.mockRejectedValueOnce(error)
    await renderPage()
    await resendExpiredInvitation()
    expect(mocks.cancelOrganizationInvitation).not.toHaveBeenCalled()
    expect(mocks.handleApiError).toHaveBeenCalledWith(error, 'Failed to resend invitation')
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('reports cleanup failure separately after creating the replacement and refreshes the list', async () => {
    const error = new Error('Cleanup failed')
    mocks.cancelOrganizationInvitation.mockRejectedValueOnce(error)
    await renderPage()
    await resendExpiredInvitation()
    expect(mocks.createOrganizationInvitation).toHaveBeenCalledTimes(1)
    expect(mocks.handleApiError).toHaveBeenCalledWith(
      error,
      'New invitation created, but failed to remove the expired invitation',
    )
    expect(mocks.listOrganizationInvitations).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledWith('New invitation created')
  })
})

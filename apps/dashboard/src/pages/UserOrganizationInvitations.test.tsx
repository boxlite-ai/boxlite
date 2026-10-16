// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, StrictMode, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import { toast } from 'sonner'
import { clear } from 'suspend-react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationsProvider } from '@/providers/OrganizationsProvider'
import { SelectedOrganizationProvider } from '@/providers/SelectedOrganizationProvider'
import UserOrganizationInvitations from './UserOrganizationInvitations'

const mocks = vi.hoisted(() => {
  const invitation = {
    id: 'inv-1',
    organizationId: 'org-2',
    organizationName: 'Acme',
    email: 'invitee@example.com',
    invitedBy: 'owner@example.com',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }
  return {
    auth: { user: { profile: { sub: 'invitee' } } },
    api: {
      organizationsApi: {
        listOrganizationInvitationsForAuthenticatedUser: vi.fn(),
        acceptOrganizationInvitation: vi.fn(),
        listOrganizations: vi.fn(),
        listOrganizationMembers: vi.fn(),
      },
    },
    invitation,
  }
})

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('react-oidc-context', () => ({ useAuth: () => mocks.auth }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => null }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page chrome reads the banner context, which this test does not mount.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}))

function SelectedOrganization() {
  const { selectedOrganization } = useSelectedOrganization()
  return <output>{selectedOrganization?.id}</output>
}

function CurrentLocation() {
  const location = useLocation()
  const navigationType = useNavigationType()
  return <output data-testid="location">{location.pathname + location.search + ' ' + navigationType}</output>
}

describe('review regressions: UserOrganizationInvitations', () => {
  let root: Root | null = null
  const { organizationsApi } = mocks.api
  const member = { userId: 'invitee', role: 'owner', assignedRoles: [] }

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Pagination asks for the viewport size; jsdom has no matchMedia.
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) as never
  })

  beforeEach(() => {
    clear()
    vi.resetAllMocks()
    localStorage.clear()
    localStorage.setItem(LocalStorageKey.SelectedOrganizationId, 'org-1')
    const own = { id: 'org-1', name: 'Personal', isDefaultForAuthenticatedUser: true }
    const joined = { id: 'org-2', name: 'Acme', isDefaultForAuthenticatedUser: false }
    organizationsApi.listOrganizations.mockResolvedValueOnce({ data: [own] }).mockResolvedValue({ data: [own, joined] })
    organizationsApi.listOrganizationMembers.mockResolvedValue({ data: [member] })
    organizationsApi.listOrganizationInvitationsForAuthenticatedUser
      .mockResolvedValueOnce({ data: [mocks.invitation] })
      .mockResolvedValue({ data: [] })
    organizationsApi.acceptOrganizationInvitation.mockResolvedValue({ data: mocks.invitation })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  async function renderInvitations(path = '/dashboard/user/invitations', strict = false) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      const page = (
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={null}>
            <OrganizationsProvider>
              <SelectedOrganizationProvider>
                <SelectedOrganization />
                <CurrentLocation />
                <Routes>
                  <Route path="/dashboard/user/invitations" element={<UserOrganizationInvitations />} />
                  <Route path="/dashboard/settings" element={<h1>Organization</h1>} />
                </Routes>
              </SelectedOrganizationProvider>
            </OrganizationsProvider>
          </Suspense>
        </MemoryRouter>
      )
      root.render(strict ? <StrictMode>{page}</StrictMode> : page)
    })
  }

  it('accepts an email link once without confirmation, including StrictMode replay', async () => {
    await renderInvitations('/dashboard/user/invitations?id=inv-1', true)
    expect(organizationsApi.acceptOrganizationInvitation).toHaveBeenCalledTimes(1)
    expect(organizationsApi.acceptOrganizationInvitation).toHaveBeenCalledWith('inv-1')
    expect(document.querySelector('output')?.textContent).toBe('org-2')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/dashboard/settings?tab=member REPLACE',
    )
  })

  it('redirects a bare legacy invitations URL without listing or accepting invitations', async () => {
    await renderInvitations()
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/dashboard/settings?tab=member REPLACE',
    )
    expect(organizationsApi.listOrganizationInvitationsForAuthenticatedUser).not.toHaveBeenCalled()
    expect(organizationsApi.acceptOrganizationInvitation).not.toHaveBeenCalled()
    expect(document.querySelector('table')).toBeNull()
  })

  it('accepts an email invitation without waiting for the removed incoming list', async () => {
    organizationsApi.listOrganizationInvitationsForAuthenticatedUser.mockReturnValue(new Promise(() => undefined))
    await renderInvitations('/dashboard/user/invitations?id=inv-1')
    expect(organizationsApi.acceptOrganizationInvitation).toHaveBeenCalledWith('inv-1')
    expect(organizationsApi.listOrganizationInvitationsForAuthenticatedUser).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe(
      '/dashboard/settings?tab=member REPLACE',
    )
  })

  it.each([404, 409, 503])(
    'shows a failed email-link join with status %s without changing organization',
    async (status) => {
      organizationsApi.acceptOrganizationInvitation.mockRejectedValueOnce({ response: { status } })
      await renderInvitations('/dashboard/user/invitations?id=inv-1')
      expect(organizationsApi.acceptOrganizationInvitation).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Unable to join')
      expect(document.querySelector('output')?.textContent).toBe('org-1')
      expect(localStorage.getItem(LocalStorageKey.SelectedOrganizationId)).toBe('org-1')
      expect(toast.success).not.toHaveBeenCalled()
    },
  )

  it('switches the console to the organization the user just joined', async () => {
    await renderInvitations('/dashboard/user/invitations?id=inv-1')

    expect(document.querySelector('output')?.textContent).toBe('org-2')
    expect(localStorage.getItem(LocalStorageKey.SelectedOrganizationId)).toBe('org-2')
  })

  it.each(['missing membership', 'request failed'])('keeps the previous selection after %s', async (failure) => {
    organizationsApi.listOrganizationMembers.mockImplementation(async (organizationId: string) => {
      if (organizationId === 'org-1') return { data: [member] }
      if (failure === 'request failed') throw new Error('Request failed with status code 429')
      return { data: [] }
    })
    await renderInvitations('/dashboard/user/invitations?id=inv-1')

    expect(document.querySelector('output')?.textContent).toBe('org-1')
    expect(localStorage.getItem(LocalStorageKey.SelectedOrganizationId)).toBe('org-1')
    expect(toast.success).toHaveBeenCalledWith('You joined Acme')
    expect(toast.error).not.toHaveBeenCalledWith('Failed to accept invitation', expect.anything())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('You joined the organization')
    expect(document.querySelector('[data-testid="location"]')?.textContent).toContain('/dashboard/user/invitations')
    expect(organizationsApi.listOrganizationInvitationsForAuthenticatedUser).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import UserOrganizationInvitations from './UserOrganizationInvitations'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  const invitation = {
    id: 'inv-1',
    organizationId: 'org-2',
    organizationName: 'Acme',
    email: 'invitee@example.com',
    invitedBy: 'owner@example.com',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  }
  // Hooks hand out stable references, as the real providers do; fresh objects on
  // every render would re-fire the page's effects forever.
  return {
    calls,
    api: {
      organizationsApi: {
        listOrganizationInvitationsForAuthenticatedUser: async () => ({ data: [invitation] }),
        acceptOrganizationInvitation: async () => {
          calls.push('accept')
          return { data: invitation }
        },
      },
    },
    organizations: {
      refreshOrganizations: async (organizationId?: string) => {
        calls.push(`refresh ${organizationId}`)
      },
    },
    selectedOrganization: {
      onSelectOrganization: async (organizationId: string) => {
        calls.push(`select ${organizationId}`)
        return true
      },
    },
    invitations: { setCount: () => undefined },
  }
})

vi.mock('@/hooks/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => mocks.organizations }))
vi.mock('@/hooks/useSelectedOrganization', () => ({ useSelectedOrganization: () => mocks.selectedOrganization }))
vi.mock('@/hooks/useUserOrganizationInvitations', () => ({ useUserOrganizationInvitations: () => mocks.invitations }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page chrome reads the banner context, which this test does not mount.
vi.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}))

describe('UserOrganizationInvitations', () => {
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

  it('switches the console to the organization the user just joined', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/user/invitations']}>
          <UserOrganizationInvitations />
        </MemoryRouter>,
      )
    })

    const accept = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Accept invitation'),
    )
    expect(accept).toBeTruthy()
    await act(async () => accept?.click())

    expect(mocks.calls).toEqual(['accept', 'refresh org-2', 'select org-2'])
  })
})

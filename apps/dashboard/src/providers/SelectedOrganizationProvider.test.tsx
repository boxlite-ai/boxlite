// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SelectedOrganizationContext } from '@/contexts/SelectedOrganizationContext'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectedOrganizationProvider } from './SelectedOrganizationProvider'

const mocks = vi.hoisted(() => {
  const listOrganizationMembers = vi.fn()
  return {
    organizations: [] as Array<{ id: string; name: string; isDefaultForAuthenticatedUser: boolean }>,
    listOrganizationMembers,
    organizationsApi: { listOrganizationMembers },
    posthog: { group: vi.fn() },
    user: { profile: { sub: 'user-1' } },
    snapshots: [] as Array<{ organizationId: string | null; loaded: boolean; role: string | null }>,
  }
})

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ organizations: mocks.organizations }),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    organizationsApi: mocks.organizationsApi,
  }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: mocks.user }),
}))

vi.mock('posthog-js/react', () => ({
  usePostHog: () => mocks.posthog,
}))

vi.mock('@/lib/error-handling', () => ({
  handleApiError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

function Probe() {
  const context = useContext(SelectedOrganizationContext)
  if (!context) {
    throw new Error('SelectedOrganizationContext missing')
  }

  mocks.snapshots.push({
    organizationId: context.selectedOrganization?.id ?? null,
    loaded: context.organizationMembersLoaded,
    role: context.authenticatedUserOrganizationMember?.role ?? null,
  })

  return null
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('SelectedOrganizationProvider membership loading', () => {
  let root: Root | null = null
  let orgBMembersResolve: ((value: { data: unknown[] }) => void) | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    localStorage.setItem('SelectedOrganizationId', 'org-a')
    mocks.snapshots.length = 0
    mocks.organizations = [{ id: 'org-a', name: 'Org A', isDefaultForAuthenticatedUser: true }]
    mocks.listOrganizationMembers.mockReset()
    mocks.listOrganizationMembers.mockImplementation((organizationId: string) => {
      if (organizationId === 'org-a') {
        return Promise.resolve({
          data: [
            {
              userId: 'user-1',
              role: OrganizationUserRoleEnum.OWNER,
              assignedRoles: [],
            },
          ],
        })
      }

      return new Promise((resolve) => {
        orgBMembersResolve = resolve
      })
    })
  })

  afterEach(async () => {
    orgBMembersResolve?.({ data: [] })
    await flushReactWork()
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('never marks membership from the previous organization loaded for a newly selected organization', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)

    const renderProvider = async () => {
      await act(async () => {
        root?.render(
          <SelectedOrganizationProvider>
            <Probe />
          </SelectedOrganizationProvider>,
        )
      })
      await flushReactWork()
    }

    await renderProvider()
    expect(mocks.snapshots).toContainEqual({
      organizationId: 'org-a',
      loaded: true,
      role: OrganizationUserRoleEnum.OWNER,
    })

    // An organizations refresh can remove the current org and select another
    // one without going through onSelectOrganization's membership prefetch.
    mocks.organizations = [{ id: 'org-b', name: 'Org B', isDefaultForAuthenticatedUser: true }]
    await renderProvider()

    expect(
      mocks.snapshots.find(
        (snapshot) =>
          snapshot.organizationId === 'org-b' && snapshot.loaded && snapshot.role === OrganizationUserRoleEnum.OWNER,
      ),
    ).toBeUndefined()
  })
})

// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn(), reset: vi.fn() }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    user: { profile: { name: 'BoxLite User', email: 'user@example.com' } },
    signoutRedirect: vi.fn(),
  }),
}))

vi.mock('usehooks-ts', () => ({
  useCopyToClipboard: () => [undefined, vi.fn()],
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

vi.mock('@/assets/Logo', () => ({ LogoText: () => <span>BoxLite</span> }))
vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}))
const organizationState = vi.hoisted(() => {
  const personal = { id: 'org-1', name: 'Default Organization', isDefaultForAuthenticatedUser: true }
  return { personal, organizations: [personal], onSelectOrganization: vi.fn(async () => true) }
})
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    onSelectOrganization: organizationState.onSelectOrganization,
  }),
}))
vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ organizations: organizationState.organizations }),
}))
vi.mock('@/hooks/useUserOrganizationInvitations', () => ({
  useUserOrganizationInvitations: () => ({ count: 2 }),
}))

describe('Sidebar primary navigation', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    // A test that adds organizations must not leak them into the next one.
    organizationState.organizations = [organizationState.personal]
  })

  it('keeps Volumes in primary navigation', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes']}>
          <Sidebar isBannerVisible={false} version="test" />
        </MemoryRouter>,
      )
    })

    const volumeLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).filter(
      (link) => link.getAttribute('href') === '/dashboard/volumes',
    )

    expect(volumeLinks.length).toBeGreaterThan(0)
    expect(volumeLinks.every((link) => link.textContent === 'Volumes')).toBe(true)
  })

  it('links the members page from the profile menu', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes']}>
          <Sidebar isBannerVisible={false} version="test" />
        </MemoryRouter>,
      )
    })

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open profile menu"]')
    // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )

    const members = [...document.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')].find(
      (item) => item.textContent === 'Members',
    )
    expect(members?.getAttribute('href')).toBe('/dashboard/members')
  })

  it('links the invitations page from the profile menu with the pending count', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes']}>
          <Sidebar isBannerVisible={false} version="test" />
        </MemoryRouter>,
      )
    })

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open profile menu"]')
    // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )

    const invitations = document.querySelector('a[role="menuitem"][href="/dashboard/user/invitations"]')
    // The label, then the badge with the pending count.
    expect(invitations?.textContent).toBe('Invitations2')
  })

  it('lets a user in several organizations switch to another one from the profile menu', async () => {
    organizationState.organizations = [
      { id: 'org-1', name: 'Default Organization', isDefaultForAuthenticatedUser: true },
      { id: 'org-2', name: 'Acme', isDefaultForAuthenticatedUser: false },
    ]
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={['/dashboard/boxes']}>
          <Sidebar isBannerVisible={false} version="test" />
        </MemoryRouter>,
      )
    })

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open profile menu"]')
    // Radix opens menus on pointerdown; jsdom has no PointerEvent, and React reads only `button`.
    await act(async () =>
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })),
    )

    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.find((item) => item.textContent?.includes('Default Organization'))?.textContent).toContain('Personal')

    await act(async () => items.find((item) => item.textContent?.includes('Acme'))?.click())
    expect(organizationState.onSelectOrganization).toHaveBeenCalledWith('org-2')
  })
})

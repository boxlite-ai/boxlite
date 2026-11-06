// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { ONBOARDING_OPEN_EVENT } from '@/lib/onboarding-progress'

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

describe('Sidebar primary navigation', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })

  beforeEach(() => localStorage.clear())

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.useRealTimers()
    // A test that adds organizations must not leak them into the next one.
    organizationState.organizations = [organizationState.personal]
  })

  function renderRoute(path: string) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Sidebar isBannerVisible={false} version="test" />
        </MemoryRouter>,
      )
    })
  }

  it('expands without changing the active route and restores the saved preference', () => {
    renderRoute('/dashboard/boxes/example')
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => toggle.click())
    expect(document.querySelector('[aria-label="Collapse navigation"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('true')
    expect(document.querySelector('nav[aria-label="Primary"] a[aria-current="page"]')?.getAttribute('href')).toBe(
      '/dashboard/boxes',
    )
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    renderRoute('/dashboard/boxes/example')
    expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
  })

  it('collapses beside the brand and expands through the compact logo without navigating', () => {
    localStorage.setItem('boxlite-navigation-expanded', 'true')
    renderRoute('/dashboard/images/registries')
    const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Collapse navigation"]')!
    const brand = document.querySelector('aside a[aria-label="BoxLite home"]')!
    expect(collapse.parentElement).toBe(brand.parentElement)
    act(() => collapse.click())
    expect(document.querySelector('[aria-label="Collapse navigation"]')).toBeNull()
    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!
    expect(expand.querySelector('img')).not.toBeNull()
    expect(document.activeElement).toBe(expand)
    act(() => expand.click())
    expect(document.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(
      '/dashboard/images/registries',
    )
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Collapse navigation')
  })

  function pointer(
    element: Element,
    type: 'pointerover' | 'pointerout',
    relatedTarget: EventTarget | null = null,
    pointerType = 'mouse',
  ) {
    const event = new MouseEvent(type, { bubbles: true, relatedTarget })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    act(() => element.dispatchEvent(event))
  }

  function preview() {
    vi.useFakeTimers()
    renderRoute('/dashboard/images/registries')
    const logo = document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!
    pointer(logo, 'pointerover')
    act(() => vi.advanceTimersByTime(350))
    return logo
  }

  it('waits for hover intent and previews without persisting expansion', () => {
    vi.useFakeTimers()
    renderRoute('/dashboard/boxes')
    const logo = document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!
    pointer(logo, 'pointerover')
    act(() => vi.advanceTimersByTime(349))
    expect(logo.getAttribute('aria-expanded')).toBe('false')
    act(() => vi.advanceTimersByTime(1))
    expect(document.querySelector('[aria-label="Pin navigation"]')).toBe(logo)
    expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('false')
    const panel = document.querySelector<HTMLElement>('aside > div')!
    expect(panel.dataset.state).toBe('preview')
    expect(panel.style.width).toBe('224px')
    expect(panel.parentElement?.style.getPropertyValue('--navigation-width')).toBe('64px')
  })

  it('ignores touch hover and cancels a brief mouse pass', () => {
    vi.useFakeTimers()
    renderRoute('/dashboard/boxes')
    const logo = document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!
    pointer(logo, 'pointerover', null, 'touch')
    act(() => vi.advanceTimersByTime(500))
    expect(logo.getAttribute('aria-expanded')).toBe('false')
    pointer(logo, 'pointerover')
    act(() => vi.advanceTimersByTime(100))
    pointer(logo, 'pointerout')
    act(() => vi.advanceTimersByTime(500))
    expect(logo.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the preview usable across the menu and closes after leaving it', () => {
    const logo = preview()
    const child = document.querySelector('nav a[href="/dashboard/images/registries"]')!
    pointer(logo, 'pointerout', child)
    act(() => vi.advanceTimersByTime(500))
    expect(logo.getAttribute('aria-expanded')).toBe('true')
    pointer(child, 'pointerout')
    act(() => vi.advanceTimersByTime(149))
    expect(logo.getAttribute('aria-expanded')).toBe('true')
    act(() => vi.advanceTimersByTime(1))
    expect(logo.getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('false')
  })

  it('cancels dismissal on re-entry and pins only when the logo is clicked', () => {
    const logo = preview()
    pointer(logo, 'pointerout')
    act(() => vi.advanceTimersByTime(100))
    pointer(logo, 'pointerover')
    act(() => vi.advanceTimersByTime(100))
    expect(logo.getAttribute('aria-expanded')).toBe('true')
    act(() => logo.click())
    act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('aside')?.style.getPropertyValue('--navigation-width')).toBe('224px')
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('true')
  })

  it('dismisses the preview with its top collapse button without pinning', () => {
    const logo = preview()
    const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Collapse navigation"]')!
    expect(collapse.parentElement).toBe(logo.parentElement)
    act(() => collapse.click())
    act(() => vi.advanceTimersByTime(500))
    expect(document.querySelector('[aria-label="Collapse navigation"]')).toBeNull()
    expect(document.activeElement).toBe(logo)
    expect(logo.getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('false')
  })

  it('does not pin when using a group within the preview', () => {
    preview()
    const management = document.querySelector<HTMLButtonElement>('[aria-label="Toggle Management navigation"]')!
    act(() => management.click())
    expect(management.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[aria-label="Pin navigation"]')).not.toBeNull()
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('false')
  })

  it('retains focused preview children and returns focus to the logo on Escape', () => {
    const logo = preview()
    const child = document.querySelector<HTMLAnchorElement>('nav a[href="/dashboard/images/registries"]')!
    act(() => child.focus())
    pointer(logo, 'pointerout')
    act(() => vi.advanceTimersByTime(500))
    expect(document.activeElement).toBe(child)
    expect(logo.getAttribute('aria-expanded')).toBe('true')
    act(() => child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.activeElement).toBe(logo)
    expect(logo.getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('boxlite-navigation-expanded')).toBe('false')
  })

  it('closes when focus leaves a preview that the pointer has already left', () => {
    const logo = preview()
    const child = document.querySelector<HTMLAnchorElement>('nav a[href="/dashboard/images/registries"]')!
    act(() => child.focus())
    pointer(logo, 'pointerout')
    act(() => vi.advanceTimersByTime(500))
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open profile menu"]')!.focus())
    act(() => vi.advanceTimersByTime(150))
    expect(logo.getAttribute('aria-expanded')).toBe('false')
  })

  it('reveals the current Images child and supports independent disclosure', () => {
    localStorage.setItem('boxlite-navigation-expanded', 'true')
    renderRoute('/dashboard/images/registries')
    const child = document.querySelector('a[href="/dashboard/images/registries"][aria-current="page"]')
    expect(child?.textContent).toBe('Private registries')
    const disclosure = document.querySelector<HTMLButtonElement>('[aria-label="Toggle Images navigation"]')!
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    act(() => disclosure.click())
    expect(document.querySelector('#images-navigation')?.hasAttribute('hidden')).toBe(true)
  })

  it('reveals registry navigation when Images is opened from the compact rail', () => {
    renderRoute('/dashboard/boxes')
    act(() => document.querySelector<HTMLAnchorElement>('nav a[href="/dashboard/images"]')!.click())
    expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
    const registry = document.querySelector<HTMLAnchorElement>('nav a[href="/dashboard/images/registries"]')!
    act(() => registry.click())
    expect(registry.getAttribute('aria-current')).toBe('page')
    const disclosure = document.querySelector<HTMLButtonElement>('[aria-label="Toggle Images navigation"]')!
    act(() => disclosure.click())
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    act(() => disclosure.click())
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  })

  it('does not treat a similar route prefix as the current feature', () => {
    renderRoute('/dashboard/images-extra')
    expect(document.querySelector('nav[aria-label="Primary"] a[aria-current="page"]')).toBeNull()
  })

  it('keeps navigation usable when preference storage is unavailable', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Unavailable')
    })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Unavailable')
    })
    try {
      renderRoute('/dashboard/boxes')
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation"]')!.click())
      expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
    } finally {
      read.mockRestore()
      write.mockRestore()
    }
  })

  it('preserves the onboarding event command', () => {
    const listener = vi.fn((event: Event) => event.preventDefault())
    window.addEventListener(ONBOARDING_OPEN_EVENT, listener)
    try {
      renderRoute('/dashboard/images')
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open onboarding guide"]')!.click())
      expect(listener).toHaveBeenCalledOnce()
      expect(document.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe('/dashboard/images')
    } finally {
      window.removeEventListener(ONBOARDING_OPEN_EVENT, listener)
    }
  })

  it('places API Keys in the header and Quickstart last in the rail footer', () => {
    renderRoute('/dashboard/keys')
    expect(document.querySelector('header a[href="/dashboard/keys"]')?.getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('aside a[href="/dashboard/keys"]')).toBeNull()
    const quickstart = document.querySelector('[aria-label="Open onboarding guide"]')!
    expect(quickstart.closest('nav')).toBeNull()
    expect(quickstart.closest('aside')).not.toBeNull()
    const actions = document.querySelectorAll('aside button')
    expect(actions[actions.length - 1]).toBe(quickstart)
  })

  it('groups resource destinations under Infrastructure separately from Management', () => {
    renderRoute('/dashboard/boxes')
    const infrastructure = document.querySelector('[role="group"][aria-label="Infrastructure"]')!
    expect([...infrastructure.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '/dashboard/boxes',
      '/dashboard/images',
      '/dashboard/checkpoints',
      '/dashboard/volumes',
      '/dashboard/domains',
    ])
    expect(infrastructure.querySelector('[aria-label="Toggle Management navigation"]')).toBeNull()
  })
  it('shows Applications CI navigation with Runners and Connects for a direct route', () => {
    localStorage.setItem('boxlite-navigation-expanded', 'true')
    renderRoute('/dashboard/ci/connects')
    const applications = document.querySelector('[role="group"][aria-label="Applications"]')
    expect(applications).not.toBeNull()
    expect(applications?.querySelector('a[href="/dashboard/ci/connects"]')?.getAttribute('aria-current')).toBe('page')
    expect(applications?.textContent).toContain('Runners')
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
    const domainLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/dashboard/domains"]')]
    expect(domainLinks.length).toBeGreaterThan(0)
    expect(domainLinks.every((link) => link.textContent === 'Domains')).toBe(true)
    expect(document.querySelector('a[href="/dashboard/ci"]')?.textContent).toBe('CI')
  })

  it('opens Management children in primary navigation from the compact rail', () => {
    renderRoute('/dashboard/boxes')
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Toggle Management navigation"]')!
    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[aria-label="Collapse navigation"]')).not.toBeNull()
    expect(document.querySelector('#management-navigation')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('nav a[href="/dashboard/billing"]')?.textContent).toBe('Billing')
    expect(document.querySelector('nav a[href="/dashboard/settings"]')?.textContent).toBe('Organization')
    act(() => trigger.click())
    expect(document.querySelector('#management-navigation')?.hasAttribute('hidden')).toBe(true)
  })

  it('reveals the current management child without preventing manual collapse', () => {
    localStorage.setItem('boxlite-navigation-expanded', 'true')
    renderRoute('/dashboard/settings')
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Toggle Management navigation"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('#management-navigation a[aria-current="page"]')?.textContent).toBe('Organization')
    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('omits the personal invitations entry from the profile menu', async () => {
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
    expect(invitations).toBeNull()
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

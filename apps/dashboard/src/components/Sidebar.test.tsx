// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RoutePath } from '@/enums/RoutePath'
import { Sidebar } from './Sidebar'

vi.mock('@/components/BoxSearchCommands', () => ({
  BoxSearchCommands: () => null,
}))

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}))

vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ axiosInstance: { get: vi.fn() } }),
}))

vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1', name: 'Organization' } }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: false }),
}))

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    signoutRedirect: vi.fn(),
    user: { profile: { email: 'user@example.com', name: 'User' } },
  }),
}))

vi.mock('usehooks-ts', () => ({
  useCopyToClipboard: () => [undefined, vi.fn()],
}))

vi.mock('./CommandPalette', () => ({
  useCommandPaletteActions: () => ({ setIsOpen: vi.fn() }),
  useRegisterCommands: vi.fn(),
}))

function getDesktopNavLink(host: HTMLElement, label: string): HTMLAnchorElement {
  const links = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter(
    (link) => link.textContent?.trim() === label && link.className.includes('md:inline-flex'),
  )
  expect(links).toHaveLength(1)
  return links[0]
}

describe('Sidebar primary navigation', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('highlights only the longest matching primary path on the Usage page', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={[RoutePath.BILLING_SPENDING]}>
          <Sidebar isBannerVisible={false} billingEnabled={false} version="test" />
        </MemoryRouter>,
      )
    })

    const usageLink = getDesktopNavLink(host, 'Usage')
    const billingLink = getDesktopNavLink(host, 'Billing')

    expect(usageLink.classList.contains('bg-accent')).toBe(true)
    expect(billingLink.classList.contains('bg-accent')).toBe(false)
  })
})

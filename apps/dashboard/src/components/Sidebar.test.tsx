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
vi.mock('@/components/BoxSearchCommands', () => ({ BoxSearchCommands: () => null }))
vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org-1' } }),
}))
vi.mock('./CommandPalette', () => ({
  useCommandPaletteActions: () => ({ setIsOpen: vi.fn() }),
  useRegisterCommands: () => undefined,
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
})

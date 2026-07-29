// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RoutePath } from './enums/RoutePath'
import App from './App'

vi.mock('./hooks/useConfig', () => ({
  useConfig: () => ({}),
}))

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    error: null,
    isAuthenticated: false,
    removeUser: vi.fn(),
    user: null,
  }),
}))

vi.mock('./pages/Dashboard', async () => {
  const { Outlet } = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { default: Outlet }
})

vi.mock('./pages/Boxes', () => ({
  default: () => <div>boxes-route</div>,
}))

vi.mock('./pages/Spending', () => ({
  default: () => <div>spending-route</div>,
}))

vi.mock('./components/LoadingFallback', () => ({
  default: () => <div>loading</div>,
}))

vi.mock('./providers/ApiProvider', () => ({
  ApiProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./providers/OrganizationsProvider', () => ({
  OrganizationsProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./providers/SelectedOrganizationProvider', () => ({
  SelectedOrganizationProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./providers/RegionsProvider', () => ({
  RegionsProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./providers/NotificationSocketProvider', () => ({
  NotificationSocketProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./providers/BoxSessionProvider', () => ({
  BoxSessionProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./components/CommandPalette', () => ({
  CommandPaletteProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./components/Banner', () => ({
  BannerProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}))

vi.mock('./vendor/pylon', () => ({
  initPylon: vi.fn(),
}))

describe('App usage route', () => {
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

  it('renders Spending instead of redirecting the usage route to boxes', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      root = createRoot(host)
      root.render(
        <MemoryRouter initialEntries={[RoutePath.BILLING_SPENDING]}>
          <App />
        </MemoryRouter>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('spending-route')
    expect(document.body.textContent).not.toContain('boxes-route')
  })
})

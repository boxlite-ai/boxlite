// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, lazy, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const state = vi.hoisted(() => ({ announcements: {} as Record<string, { text: string }>, shellMounts: 0 }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ version: 'test', announcements: state.announcements }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: undefined }),
}))
vi.mock('@/hooks/queries/billingQueries', () => ({ useOwnerWalletQuery: () => ({}) }))
vi.mock('@/hooks/useSuspensionBanner', () => ({ useSuspensionBanner: () => {} }))
vi.mock('@/components/VerifyEmailDialog', () => ({ VerifyEmailDialog: () => null }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/components/OnboardingDialogHost', () => ({ OnboardingDialogHost: () => null }))
vi.mock('@/components/Sidebar', async () => {
  const { useState } = await import('react')
  return {
    Sidebar: ({ children }: { children: ReactNode }) => {
      const [mount] = useState(() => ++state.shellMounts)
      return (
        <div>
          <nav aria-label="Shell">Navigation {mount}</nav>
          {children}
        </div>
      )
    },
  }
})
let root: Root | undefined
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  state.announcements = {}
  state.shellMounts = 0
  localStorage.clear()
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
})
async function mount(path: string, extra?: ReactNode) {
  const router = createMemoryRouter(
    [
      {
        path: '/dashboard',
        element: <Dashboard />,
        children: [
          { path: 'boxes', element: <h1>Boxes content</h1> },
          { path: 'welcome', element: <h1>Welcome content</h1> },
          { path: 'pending', element: extra },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  const host = document.createElement('div')
  document.body.append(host)
  await act(async () => {
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
  })
  return router
}
describe('dashboard shell layout', () => {
  it('preserves navigation while a child route suspends and then resolves', async () => {
    let resolve!: (value: { default: () => ReactNode }) => void
    const Pending = lazy(
      () =>
        new Promise<{ default: () => ReactNode }>((done) => {
          resolve = done
        }),
    )
    const router = await mount('/dashboard/boxes', <Pending />)
    const shell = document.querySelector('nav')
    await act(async () => {
      await router.navigate('/dashboard/pending')
    })
    expect(document.querySelector('nav')).toBe(shell)
    expect(state.shellMounts).toBe(1)
    await act(async () => {
      resolve({ default: () => <h1>Loaded content</h1> })
    })
    expect(document.querySelector('nav')).toBe(shell)
    expect(document.body.textContent).toContain('Loaded content')
  })
  it('renders the Welcome outlet without feature navigation', async () => {
    await mount('/dashboard/welcome')
    expect(document.querySelector('nav')).toBeNull()
    expect(document.body.textContent).toContain('Welcome content')
    expect(document.body.textContent).toContain('GET STARTED WITH BOXLITE')
  })
  it('dismisses an announcement while retaining shell and route content', async () => {
    state.announcements = { release: { text: 'New release' } }
    await mount('/dashboard/boxes')
    const shell = document.querySelector('nav')
    expect(document.body.textContent).toContain('New release')
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss announcement"]')!.click())
    expect(document.body.textContent).not.toContain('New release')
    expect(document.querySelector('nav')).toBe(shell)
    expect(document.body.textContent).toContain('Boxes content')
  })
})

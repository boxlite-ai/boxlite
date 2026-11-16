// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Dashboard from '../../pages/Dashboard'

const api = vi.hoisted(() => ({
  organizationsApi: { listOrganizationMembers: vi.fn() },
  apiKeyApi: { listApiKeys: vi.fn() },
  boxApi: { listBoxesPaginated: vi.fn() },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => api }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'user' } } }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ version: 'test' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: { id: 'org' } }),
}))
vi.mock('@/hooks/queries/billingQueries', () => ({ useOwnerWalletQuery: () => ({}) }))
vi.mock('@/hooks/useSuspensionBanner', () => ({ useSuspensionBanner: () => {} }))
vi.mock('@/components/VerifyEmailDialog', () => ({ VerifyEmailDialog: () => null }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/components/OnboardingDialogHost', () => ({ OnboardingDialogHost: () => null }))
vi.mock('@/components/Sidebar', () => ({
  Sidebar: ({ children }: { children: ReactNode }) => (
    <>
      <nav>Console navigation</nav>
      {children}
    </>
  ),
}))
let root: Root
let client: QueryClient
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  api.organizationsApi.listOrganizationMembers
    .mockReset()
    .mockResolvedValue({ data: [{ userId: 'user', role: 'owner' }] })
  api.apiKeyApi.listApiKeys.mockReset().mockResolvedValue({ data: [] })
  api.boxApi.listBoxesPaginated.mockReset().mockResolvedValue({ data: { total: 0 } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  document.body.innerHTML = ''
})
async function mount(path = '/dashboard/boxes') {
  const router = createMemoryRouter(
    [
      {
        path: '/dashboard',
        element: <Dashboard />,
        children: [
          { path: 'boxes', element: <h1>Boxes content</h1> },
          { path: 'welcome', element: <h1>Welcome content</h1> },
          { path: 'keys', element: <h1>Keys content</h1> },
          { path: 'quickstart', element: <h1>Quickstart content</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  )
  return router
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}
it.each(['/dashboard/boxes', '/dashboard/boxes/', '/DASHBOARD/BOXES', '/dashboard/', '/DASHBOARD'])(
  'setup entry %s never mounts Console while the account decision is pending',
  async (path) => {
    let resolve!: (value: { data: { total: number } }) => void
    api.boxApi.listBoxesPaginated.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const router = await mount(path)
    await flush()
    expect(document.querySelector('nav')).toBeNull()
    expect(document.body.textContent).not.toContain('Boxes content')
    await act(async () => resolve({ data: { total: 0 } }))
    await flush()
    expect(router.state.location.pathname).toBe('/dashboard/welcome')
    expect(document.querySelector('nav')).toBeNull()
  },
)
it('setup entry keeps read failures recoverable without showing Console', async () => {
  api.boxApi.listBoxesPaginated.mockRejectedValueOnce(new Error('offline'))
  await mount()
  await flush()
  await flush()
  expect(document.querySelector('nav')).toBeNull()
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  api.boxApi.listBoxesPaginated.mockResolvedValue({ data: { total: 1 } })
  await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
  await flush()
  await flush()
  expect(document.body.textContent).toContain('Boxes content')
})
it('setup entry preserves explicit deep links', async () => {
  await mount('/dashboard/keys')
  expect(document.body.textContent).toContain('Keys content')
  expect(api.organizationsApi.listOrganizationMembers).not.toHaveBeenCalled()
})

it('setup entry keeps navigation mounted when a deep link leads to Boxes', async () => {
  const router = await mount('/dashboard/keys')
  const nav = document.querySelector('nav')
  expect(nav).not.toBeNull()
  await act(async () => {
    await router.navigate('/dashboard/boxes')
  })
  await flush()
  expect(document.querySelector('nav')).toBe(nav)
  expect(document.body.textContent).toContain('Boxes content')
  expect(api.organizationsApi.listOrganizationMembers).not.toHaveBeenCalled()
})

it('setup entry keeps an explicit onboarding request after deep-link admission', async () => {
  const router = await mount('/dashboard/keys')
  await act(async () => {
    await router.navigate('/dashboard/boxes?onboarding=1')
  })
  expect(document.body.textContent).toContain('Quickstart content')
})

it('setup entry does not admit Console just because Welcome was opened', async () => {
  const router = await mount('/dashboard/welcome')
  api.boxApi.listBoxesPaginated.mockImplementation(() => new Promise(() => {}))
  await act(async () => {
    await router.navigate('/dashboard/boxes')
  })
  expect(document.querySelector('nav')).toBeNull()
  expect(document.body.textContent).toContain('Preparing your organization')
})

it('setup entry admits non-owner members without owner-only reads', async () => {
  api.organizationsApi.listOrganizationMembers.mockResolvedValue({ data: [{ userId: 'user', role: 'member' }] })
  await mount()
  await flush()
  await flush()
  expect(document.body.textContent).toContain('Boxes content')
  expect(api.apiKeyApi.listApiKeys).not.toHaveBeenCalled()
})

it('setup entry preserves the admitted navigation across route changes', async () => {
  api.boxApi.listBoxesPaginated.mockResolvedValue({ data: { total: 1 } })
  const router = await mount()
  await flush()
  await flush()
  const nav = document.querySelector('nav')
  expect(nav).not.toBeNull()
  await act(async () => {
    await router.navigate('/dashboard/keys')
  })
  expect(document.querySelector('nav')).toBe(nav)
  await act(async () => {
    await router.navigate('/dashboard/boxes')
  })
  expect(document.querySelector('nav')).toBe(nav)
})

it.each([true, false])('setup entry rechecks a cached decision (%s) before showing a destination', async (cached) => {
  client.setQueryData(['onboarding-entry', 'user', 'org'], cached)
  let resolve!: (value: { data: { total: number } }) => void
  api.boxApi.listBoxesPaginated.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const router = await mount()
  await flush()
  expect(router.state.location.pathname).toBe('/dashboard/boxes')
  expect(document.querySelector('nav')).toBeNull()
  await act(async () => resolve({ data: { total: 1 } }))
  await flush()
  expect(document.body.textContent).toContain('Boxes content')
})

// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import FirstBoxWelcome from './FirstBoxWelcome'
const api = vi.hoisted(() => ({
  profile: vi.fn(),
  rename: vi.fn(),
  save: vi.fn(),
  credits: vi.fn(),
  refresh: vi.fn(),
  wallet: vi.fn(),
  methods: vi.fn(),
  organizationId: 'org-1',
  userId: 'user-1',
  billingApiUrl: 'https://billing.example.test',
}))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    getOrganizationOnboarding: api.profile,
    saveOrganizationOnboarding: api.save,
    organizationsApi: { updateOrganizationName: api.rename },
    billingApi: {
      getSignupCreditDelivery: api.credits,
      getOrganizationWallet: api.wallet,
      listAllPaymentMethods: api.methods,
    },
  }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: api.organizationId, name: 'Existing workspace' },
    authenticatedUserOrganizationMember: { role: 'owner' },
  }),
}))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => ({ refreshOrganizations: api.refresh }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: api.billingApiUrl }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: api.userId } } }) }))
vi.mock('./FirstBoxAtmosphere', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
let host: HTMLDivElement, root: Root, client: QueryClient
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  api.billingApiUrl = 'https://billing.example.test'
  localStorage.clear()
  api.organizationId = 'org-1'
  api.userId = 'user-1'
  api.wallet.mockResolvedValue({ creditCardConnected: false, balanceCents: 0, ongoingBalanceCents: 0, name: 'Wallet' })
  api.methods.mockResolvedValue([])
  api.profile.mockResolvedValue(null)
  api.credits.mockResolvedValue({ delivered: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  localStorage.clear()
})
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}
async function mount() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/welcome']}>
          <Routes>
            <Route path="/welcome" element={<FirstBoxWelcome />} />
            <Route path="/dashboard/quickstart" element={<p>Quickstart destination</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  )
  await settle()
}
async function click(text: string) {
  const b = Array.from(host.querySelectorAll('button')).find((e) => e.textContent?.trim() === text)!
  await act(async () => b.click())
  await settle()
}
async function input(id: string, value: string) {
  const e = host.querySelector('#' + id)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      e.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(e, value)
    e.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('saves the name and selected intent before offering optional credits', async () => {
  await mount()
  expect(host.textContent).toContain('Create your organization')
  await input('welcome-organization', 'New team')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  await act(async () => host.querySelector<HTMLInputElement>('#welcome-terms')!.click())
  await click('Continue')
  expect(api.rename).toHaveBeenCalledWith('org-1', { name: 'New team' })
  expect(host.textContent).toContain('What are you building?')
  await act(async () => host.querySelector<HTMLInputElement>('input[value="long-running-agent"]')!.click())
  await input('welcome-note', 'Run an agent overnight')
  await click('Continue')
  expect(api.save).toHaveBeenCalledWith('org-1', { useCase: 'long-running-agent', note: 'Run an agent overnight' })
  expect(host.textContent).toContain('3 Get credits')
  expect(host.textContent).toContain('Verify card & claim $100')
  expect(api.credits).not.toHaveBeenCalled()
  expect(localStorage.getItem('SkipOnboarding_user-1')).toBeNull()
  await click('Explore with BoxLite')
  expect(host.textContent).toContain('Quickstart destination')
})
it('restores saved intent, supports going back, and keeps failed submissions retryable', async () => {
  api.profile.mockResolvedValue({ useCase: 'coding-agent', note: 'Saved note' })
  await mount()
  expect(host.textContent).toContain('3 Get credits')
  await click('Back')
  expect(host.querySelector<HTMLTextAreaElement>('#welcome-note')!.value).toBe('Saved note')
  await click('Back')
  expect(host.querySelector<HTMLInputElement>('#welcome-organization')!.value).toBe('Existing workspace')
  await act(async () => host.querySelector<HTMLInputElement>('#welcome-terms')!.click())
  await click('Continue')
  await act(async () => host.querySelector<HTMLInputElement>('input[value="exploring"]')!.click())
  api.save.mockRejectedValue(new Error('Try saving later'))
  await click('Continue')
  expect(host.textContent).toContain('Try saving later')
  expect(api.credits).not.toHaveBeenCalled()
  api.save.mockResolvedValue({})
  await click('Try again')
  expect(host.textContent).toContain('Verify card & claim $100')
})
it('shows profile loading failures and reloads them without losing the page', async () => {
  api.profile.mockRejectedValue(new Error('offline'))
  await mount()
  expect(host.textContent).toContain('Could not load your setup')
  api.profile.mockResolvedValue(null)
  await click('Try again')
  expect(host.textContent).toContain('Create your organization')
})

it('restores the confirmed organization step after reloading before intent submission', async () => {
  localStorage.setItem('boxlite:welcome:user-1:org-1', JSON.stringify({ organizationName: 'Existing workspace' }))
  await mount()
  expect(host.textContent).toContain('What are you building?')
  await click('Back')
  expect(host.querySelector<HTMLInputElement>('#welcome-organization')!.value).toBe('Existing workspace')
})

it('opens Quickstart without billing or a fabricated credit grant', async () => {
  api.billingApiUrl = ''
  api.profile.mockResolvedValue({ useCase: 'exploring', note: '' })
  await mount()
  expect(host.textContent).not.toContain('signup credits')
  await click('Start quickstart')
  expect(host.textContent).toContain('Quickstart destination')
  expect(api.credits).not.toHaveBeenCalled()
})

it('restores completion after continuing without credits instead of repeating setup', async () => {
  localStorage.setItem(
    'boxlite:welcome:user-1:org-1',
    JSON.stringify({
      organizationName: 'Existing workspace',
      completedAt: 1793200000000,
      creditGrantedAt: null,
    }),
  )
  api.profile.mockResolvedValue({ useCase: 'exploring', note: '' })
  await mount()
  expect(host.textContent).toContain('Quickstart destination')
  expect(api.save).not.toHaveBeenCalled()
  expect(api.credits).not.toHaveBeenCalled()
})

it('restores the saved credits step and completion without repeating API writes', async () => {
  api.profile.mockResolvedValue({ useCase: 'coding-agent', note: 'Saved' })
  await mount()
  expect(host.textContent).toContain('Verify card & claim $100')
  await click('Explore with BoxLite')
  expect(host.textContent).toContain('Quickstart destination')
  expect(JSON.parse(localStorage.getItem('boxlite:welcome:user-1:org-1')!)).toMatchObject({
    completedAt: expect.any(Number),
    useCase: 'coding-agent',
    note: 'Saved',
  })
  await act(async () => root.unmount())
  root = createRoot(host)
  await mount()
  expect(host.textContent).toContain('Quickstart destination')
  expect(api.save).not.toHaveBeenCalled()
  expect(api.credits).not.toHaveBeenCalled()
})

it('keeps another organization on its own unfinished credits step', async () => {
  localStorage.setItem('boxlite:welcome:user-1:org-1', JSON.stringify({ completedAt: Date.now() }))
  api.profile.mockResolvedValue({ useCase: 'exploring', note: '' })
  api.organizationId = 'org-2'
  await mount()
  expect(host.textContent).toContain('Verify card & claim $100')
  expect(host.textContent).not.toContain('Quickstart destination')
  await click('Explore with BoxLite')
  expect(JSON.parse(localStorage.getItem('boxlite:welcome:user-1:org-2')!)).toMatchObject({
    completedAt: expect.any(Number),
  })
})

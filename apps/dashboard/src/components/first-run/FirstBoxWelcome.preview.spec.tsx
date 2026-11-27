// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  organization: { id: 'org-preview', name: 'Acme' },
  api: {
    getOrganizationOnboarding: vi.fn(),
    saveOrganizationOnboarding: vi.fn(),
    organizationsApi: { updateOrganizationName: vi.fn() },
  },
  refresh: vi.fn(),
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => fixture.api }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({ selectedOrganization: fixture.organization }),
}))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => ({ refreshOrganizations: fixture.refresh }) }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: '/billing' }) }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: 'preview-user' } } }) }))
vi.mock('./FirstBoxAtmosphere', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./WelcomeJourneyArtwork', () => ({ default: () => null }))
vi.mock('./WelcomeBoxIllustration', () => ({ default: () => null }))
vi.mock('./WelcomeCreditsStep', () => ({ default: () => <p>Existing credits step</p> }))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
let client: QueryClient
function Location() {
  return <output>{useLocation().pathname}</output>
}
async function render(query: string, mocking = true, dev = true) {
  vi.stubEnv('DEV', dev)
  vi.stubEnv('VITE_ENABLE_MOCKING', mocking ? 'true' : 'false')
  window.history.replaceState({}, '', `/dashboard/welcome${query}`)
  vi.resetModules()
  const { default: Welcome } = await import('./FirstBoxWelcome')
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Welcome />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  )
  await settle()
}
async function settle() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.textContent).not.toMatch(/Loading plans|Loading your organization/)
  })
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
  await settle()
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  fixture.organization = { id: 'org-preview', name: 'Acme' }
  fixture.api.getOrganizationOnboarding.mockResolvedValue({ useCase: 'coding-agent', note: 'Saved context' })
  fixture.api.saveOrganizationOnboarding.mockResolvedValue(undefined)
  fixture.api.organizationsApi.updateOrganizationName.mockResolvedValue(undefined)
  fixture.refresh.mockResolvedValue(undefined)
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
  vi.unstubAllEnvs()
  window.history.replaceState({}, '', '/')
})
describe('Welcome trial preview integration', () => {
  it.each([
    ['no query', '', true, true],
    ['mocking disabled', '?preview=trial-onboarding&step=plans', false, true],
    ['production', '?preview=trial-onboarding&step=plans', true, false],
  ])('keeps the existing credits flow with %s', async (_name, query, mocking, dev) => {
    await render(query, mocking, dev)
    expect(host.textContent).toContain('Existing credits step')
    expect(host.textContent).toContain('3 Get credits')
    expect(host.textContent).not.toContain('Try a plan free')
  })
  it('starts at blank organization despite saved onboarding and completion', async () => {
    localStorage.setItem(
      'boxlite:welcome:preview-user:org-preview',
      JSON.stringify({ completedAt: 123, organizationName: 'Acme' }),
    )
    await render('?preview=trial-onboarding')
    expect(host.textContent).toContain('Name your organization')
    expect((host.querySelector('#welcome-organization') as HTMLInputElement).value).toBe('')
    expect(host.textContent).toContain('3 Get started')
    expect(host.querySelector('output')?.textContent).toBe('/')
  })
  it('saves a new organization and use case before displaying that name in the offer', async () => {
    await render('?preview=trial-onboarding')
    const input = host.querySelector('#welcome-organization') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New workspace')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Continue')
    expect(fixture.api.organizationsApi.updateOrganizationName).toHaveBeenCalledWith('org-preview', {
      name: 'New workspace',
    })
    await act(async () => (host.querySelector('input[value="exploring"]') as HTMLInputElement).click())
    await click('Continue')
    expect(host.textContent).toContain('For New workspace')
    expect(host.textContent).toContain('Try a plan free for 3 days')
  })
  it('preserves the existing use-case form when returning from plans and completes Welcome on activation', async () => {
    await render('?preview=trial-onboarding&step=plans')
    expect(host.textContent).toContain('For Acme')
    await click('Back')
    expect((host.querySelector('input[value="exploring"]') as HTMLInputElement).checked).toBe(true)
    await act(async () => (host.querySelector('input[value="coding-agent"]') as HTMLInputElement).click())
    await click('Continue')
    expect(fixture.api.saveOrganizationOnboarding).toHaveBeenCalledWith('org-preview', {
      useCase: 'coding-agent',
      note: '',
    })
    await click('Continue to free trial')
    await click('Verify card')
    expect(host.querySelector('output')?.textContent).toBe('/')
    await click('Start 3-day trial')
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
    expect(JSON.parse(localStorage.getItem('boxlite:welcome:preview-user:org-preview')!).completedAt).toBeGreaterThan(0)
  })
  it('passes unavailable eligibility through and completes no-card exploration', async () => {
    await render('?preview=trial-onboarding&step=plans&scenario=unavailable')
    expect(host.querySelector('[role="alert"]')).toBeTruthy()
    expect(host.textContent).not.toContain('Continue to free trial')
    await click('Explore console — no card required')
    expect(host.querySelector('output')?.textContent).toBe('/dashboard/quickstart')
    expect(fixture.api.saveOrganizationOnboarding).not.toHaveBeenCalled()
  })
})

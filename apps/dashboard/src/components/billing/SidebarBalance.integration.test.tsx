// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { BillingApiClient } from '@/billing-api/billingApiClient'
import { SidebarBalance } from './SidebarBalance'

const scope = vi.hoisted(() => ({ id: 'org-a', role: 'owner', configured: true }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: scope.configured ? '/billing' : '' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: scope.id },
    authenticatedUserOrganizationMember: { role: scope.role },
  }),
}))
let api: BillingApiClient
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ billingApi: api }) }))
let root: Root
let client: QueryClient
let requests: string[]
const adapter = axios.defaults.adapter
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(scope, { id: 'org-a', role: 'owner', configured: true })
  requests = []
  axios.defaults.adapter = async (config) => {
    requests.push(config.url!)
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: config.url!.endsWith('/plan')
        ? {}
        : {
            balanceCents: scope.id === 'org-a' ? 1234 : 5678,
            ongoingBalanceCents: scope.id === 'org-a' ? 1234 : 5678,
            name: 'Wallet',
            creditCardConnected: false,
            usageChargeMultiplier: '1.0000',
          },
    }
  }
  api = new BillingApiClient('http://billing.test', 'test-token')
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  document.body.innerHTML = ''
  axios.defaults.adapter = adapter
})
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SidebarBalance expanded />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  )
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}
describe('SidebarBalance API integration', () => {
  it('reads only existing wallet and plan endpoints and isolates organization caches', async () => {
    await render()
    await settle()
    expect(document.body.textContent).toContain('$12.34')
    expect(requests.sort()).toEqual(['/organization/org-a/plan', '/organization/org-a/wallet'])
    scope.id = 'org-b'
    await render()
    expect(document.body.textContent).not.toContain('$12.34')
    await settle()
    expect(document.body.textContent).toContain('$56.78')
    expect(requests).toContain('/organization/org-b/wallet')
    expect(requests).toContain('/organization/org-b/plan')
    scope.role = 'member'
    await render()
    expect(document.body.textContent).toBe('')
  })
  it.each(['member', 'unconfigured'])('does not request billing for %s scope', async (kind) => {
    if (kind === 'member') scope.role = 'member'
    else scope.configured = false
    await render()
    await settle()
    expect(requests).toEqual([])
    expect(document.body.textContent).toBe('')
  })
})

// @vitest-environment jsdom
import { act, useContext } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelectedOrganizationProvider } from './SelectedOrganizationProvider'
import { SelectedOrganizationContext, ISelectedOrganizationContext } from '@/contexts/SelectedOrganizationContext'
const mocks = vi.hoisted(() => ({
  api: { listOrganizationMembers: vi.fn() },
  organizations: [{ id: 'one', name: 'One' }],
  user: { profile: { sub: 'user' } },
}))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ organizationsApi: mocks.api }) }))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => ({ organizations: mocks.organizations }) }))
vi.mock('@/hooks/queries/useOrganizationBoxLimitsQuery', () => ({ useOrganizationBoxLimitsQuery: () => {} }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => null }))
vi.mock('@/lib/error-handling', () => ({ handleApiError: vi.fn() }))
let root: Root
let context: ISelectedOrganizationContext
function Probe() {
  context = useContext(SelectedOrganizationContext)!
  return (
    <div>
      {context.selectedOrganization?.id}:{context.organizationMembersStatus}
    </div>
  )
}
const render = () =>
  act(async () =>
    root.render(
      <SelectedOrganizationProvider>
        <Probe />
      </SelectedOrganizationProvider>,
    ),
  )
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.api.listOrganizationMembers.mockReset()
  mocks.organizations = [{ id: 'one', name: 'One' }]
  sessionStorage.clear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})
describe('key permission readiness', () => {
  it('distinguishes failed membership loading from a ready empty result and retries', async () => {
    mocks.api.listOrganizationMembers.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [] })
    await render()
    expect(document.body.textContent).toBe('one:error')
    await act(async () => {
      await context.refreshOrganizationMembers()
    })
    expect(document.body.textContent).toBe('one:ready')
  })
  it('does not use the previous organization readiness while the new members load', async () => {
    mocks.api.listOrganizationMembers
      .mockResolvedValueOnce({ data: [] })
      .mockImplementationOnce(() => new Promise(() => {}))
    await render()
    expect(document.body.textContent).toBe('one:ready')
    mocks.organizations = [{ id: 'two', name: 'Two' }]
    await render()
    expect(document.body.textContent).toBe('two:loading')
  })
})

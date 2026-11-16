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

it.each(['success', 'failure'])('ignores an older refresh %s after a newer refresh completes', async (outcome) => {
  mocks.api.listOrganizationMembers.mockResolvedValueOnce({ data: [] })
  await render()
  let resolveOld!: (value: unknown) => void
  let rejectOld!: (error: Error) => void
  mocks.api.listOrganizationMembers.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        resolveOld = resolve
        rejectOld = reject
      }),
  )
  const newerMembers = [{ userId: 'newer', assignedRoles: [] }]
  mocks.api.listOrganizationMembers.mockResolvedValueOnce({ data: newerMembers })
  let older!: Promise<unknown>
  await act(async () => {
    older = context.refreshOrganizationMembers().catch(() => undefined)
  })
  await act(async () => {
    await context.refreshOrganizationMembers()
  })
  await act(async () => {
    if (outcome === 'success') resolveOld({ data: [] })
    else rejectOld(new Error('older request failed'))
    await older
  })
  expect(context.organizationMembers).toEqual(newerMembers)
  expect(context.organizationMembersStatus).toBe('ready')
})

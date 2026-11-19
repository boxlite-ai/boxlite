// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlanSetupReturn } from './PlanSetupReturn'
import { consumePlanSetup, savePlanSetup } from './planSetupIntent'
const identity = vi.hoisted(() => ({ subject: 'user', org: 'org', role: 'owner', status: 'ready' }))
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: { profile: { sub: identity.subject } } }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: identity.org },
    organizationMembersStatus: identity.status,
    authenticatedUserOrganizationMember: { role: identity.role },
  }),
}))
let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  sessionStorage.clear()
  Object.assign(identity, { subject: 'user', org: 'org', role: 'owner', status: 'ready' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  sessionStorage.clear()
  vi.restoreAllMocks()
})
let navigateWithinBilling: ReturnType<typeof useNavigate>
function Location() {
  navigateWithinBilling = useNavigate()
  const l = useLocation()
  return <output>{l.pathname + l.search}</output>
}
function render(path = '/dashboard/billing', key = 'default') {
  act(() =>
    root.render(
      <MemoryRouter
        initialEntries={[
          { pathname: path.split('?')[0], search: path.includes('?') ? '?' + path.split('?')[1] : '', key },
        ]}
      >
        <PlanSetupReturn />
        <Location />
      </MemoryRouter>,
    ),
  )
}
// A checkout return is a new document, so its intent was written by another document.
function seedReturn(subject: string, org: string, planId: string) {
  sessionStorage.setItem(
    'boxlite:plan-card-setup:' + JSON.stringify([subject, org]),
    JSON.stringify({ planId, at: Date.now(), documentId: 'previous-document' }),
  )
}
it('restores the selected plan to explicit confirmation and consumes navigation once', () => {
  seedReturn('user', 'org', 'pro')
  render()
  expect(host.textContent).toBe('/dashboard/billing/plan/pro?setup=return')
  expect(consumePlanSetup('user', 'org')).toBeNull()
})
it('does not consume another account or organization selection', () => {
  savePlanSetup('other', 'org', 'pro')
  savePlanSetup('user', 'other', 'max')
  render()
  expect(host.textContent).toBe('/dashboard/billing')
  expect(consumePlanSetup('other', 'org')).toBe('pro')
  expect(consumePlanSetup('user', 'other')).toBe('max')
})
it('waits for owner membership before consuming', () => {
  seedReturn('user', 'org', 'pro')
  identity.role = 'member'
  render()
  expect(host.textContent).toBe('/dashboard/billing')
  expect(consumePlanSetup('user', 'org')).toBe('pro')
})
it('expires pending selections and handles inaccessible storage', () => {
  savePlanSetup('user', 'org', 'pro')
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60 * 1000)
  expect(consumePlanSetup('user', 'org')).toBeNull()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked')
  })
  expect(savePlanSetup('user', 'org', 'pro')).toBe(false)
})
it('ignores malformed data and future timestamps', () => {
  sessionStorage.setItem('boxlite:plan-card-setup:["user","org"]', 'bad')
  expect(consumePlanSetup('user', 'org')).toBeNull()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 60000)
  savePlanSetup('user', 'org', 'pro')
  vi.mocked(Date.now).mockReturnValue(now)
  expect(consumePlanSetup('user', 'org')).toBeNull()
})

it('does not consume intent using membership left over from a previous organization', () => {
  seedReturn('user', 'org', 'pro')
  identity.status = 'loading'
  render()
  expect(host.textContent).toBe('/dashboard/billing')
  expect(consumePlanSetup('user', 'org')).toBe('pro')
})

it.each(['?tab=wallet&code=ACME50', '?tab=plans', '?code=ACME50'])(
  'preserves an explicit Billing destination %s',
  (query) => {
    seedReturn('user', 'org', 'pro')
    render('/dashboard/billing' + query)
    expect(host.textContent).toBe('/dashboard/billing' + query)
    act(() => navigateWithinBilling('/dashboard/billing'))
    expect(host.textContent).toBe('/dashboard/billing')
    expect(consumePlanSetup('user', 'org')).toBeNull()
  },
)
it.each(['internal-navigation', 'default'])(
  'does not resume a selection created in this document on %s history entries',
  (key) => {
    savePlanSetup('user', 'org', 'pro')
    render('/dashboard/billing', key)
    expect(host.textContent).toBe('/dashboard/billing')
    expect(consumePlanSetup('user', 'org')).toBe('pro')
  },
)

it('waits for membership on a returned document without losing eligibility', () => {
  seedReturn('user', 'org', 'pro')
  identity.status = 'loading'
  render('/dashboard/billing', 'preserved-entry')
  expect(host.textContent).toBe('/dashboard/billing')
  identity.status = 'ready'
  render('/dashboard/billing', 'preserved-entry')
  expect(host.textContent).toBe('/dashboard/billing/plan/pro?setup=return')
})

it('clears a same-document selection on explicit navigation before permissions resolve', () => {
  savePlanSetup('user', 'org', 'pro')
  savePlanSetup('user', 'other', 'max')
  identity.status = 'loading'
  render('/dashboard/billing?tab=wallet')
  expect(consumePlanSetup('user', 'org')).toBeNull()
  expect(consumePlanSetup('user', 'other')).toBe('max')
  act(() => navigateWithinBilling('/dashboard/billing'))
  identity.status = 'ready'
  render()
  expect(host.textContent).toBe('/dashboard/billing')
})

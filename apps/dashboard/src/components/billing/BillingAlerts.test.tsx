// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SignupCreditBanner } from './BillingAlerts'

const state = vi.hoisted(() => ({
  emailVerified: true,
  isDefaultForAuthenticatedUser: true,
  role: 'owner',
  pending: true,
  asked: [] as Array<{ organizationId: string; enabled?: boolean }>,
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { email_verified: state.emailVerified } } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1', isDefaultForAuthenticatedUser: state.isDefaultForAuthenticatedUser },
    authenticatedUserOrganizationMember: { role: state.role },
  }),
}))
// The owner scope in billingQueries runs for real; only the read is stubbed.
vi.mock('@/hooks/queries/useOrganizationSignupCreditPending', () => ({
  useOrganizationSignupCreditPending: (request: { organizationId: string; enabled?: boolean }) => {
    state.asked.push(request)
    return Boolean(request.enabled) && state.pending
  },
}))

describe('SignupCreditBanner', () => {
  let root: Root
  let host: HTMLDivElement

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    Object.assign(state, { emailVerified: true, isDefaultForAuthenticatedUser: true, role: 'owner', pending: true })
    state.asked = []
    host = document.createElement('div')
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('tells a verified owner of their default organization that the credit is on its way', () => {
    act(() => root.render(<SignupCreditBanner />))
    expect(state.asked).toEqual([{ organizationId: 'org-1', enabled: true }])
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Registration rewards are being distributed, please wait patiently.',
    )
  })

  it.each([
    ['a member who is not the owner', { role: 'member' }],
    ['an owner whose email is unverified', { emailVerified: false }],
    ['an owner outside their default organization', { isDefaultForAuthenticatedUser: false }],
  ])('does not ask for %s, whom no credit is granted to', (_who, overrides) => {
    Object.assign(state, overrides)
    act(() => root.render(<SignupCreditBanner />))
    expect(state.asked).toEqual([{ organizationId: 'org-1', enabled: false }])
    expect(host.innerHTML).toBe('')
  })

  it('renders nothing once nothing is pending', () => {
    state.pending = false
    act(() => root.render(<SignupCreditBanner />))
    expect(host.innerHTML).toBe('')
  })
})

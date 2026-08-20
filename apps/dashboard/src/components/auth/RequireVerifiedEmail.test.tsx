// @vitest-environment jsdom
/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPendingEmailVerificationReturnTo } from '@/lib/auth-session'
import { RequireVerifiedEmail } from './RequireVerifiedEmail'

const mocks = vi.hoisted(() => ({
  emailVerificationRequired: true,
  emailVerified: false as boolean | undefined,
  navigateTo: vi.fn(),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    user: { profile: { email_verified: mocks.emailVerified } },
  }),
}))

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ oidc: { emailVerificationRequired: mocks.emailVerificationRequired } }),
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/dashboard/billing', search: '?invoice=1' }),
  Navigate: ({ to }: { to: string }) => {
    mocks.navigateTo(to)
    return null
  },
}))

describe('RequireVerifiedEmail', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.emailVerificationRequired = true
    mocks.emailVerified = false
    mocks.navigateTo.mockReset()
    sessionStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('keeps an unverified account outside dashboard providers and remembers the destination', async () => {
    await act(async () => {
      root.render(
        <RequireVerifiedEmail>
          <div>Dashboard providers mounted</div>
        </RequireVerifiedEmail>,
      )
    })

    expect(document.body.textContent).not.toContain('Dashboard providers mounted')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/verify-email')
    expect(getPendingEmailVerificationReturnTo()).toBe('/dashboard/billing?invoice=1')
  })

  it('admits verified accounts and explicit local verification bypasses', async () => {
    mocks.emailVerified = true
    await act(async () => {
      root.render(
        <RequireVerifiedEmail>
          <div>Dashboard providers mounted</div>
        </RequireVerifiedEmail>,
      )
    })
    expect(document.body.textContent).toContain('Dashboard providers mounted')

    mocks.emailVerificationRequired = false
    mocks.emailVerified = undefined
    await act(async () => {
      root.render(
        <RequireVerifiedEmail>
          <div>Local dashboard mounted</div>
        </RequireVerifiedEmail>,
      )
    })
    expect(document.body.textContent).toContain('Local dashboard mounted')
  })
})

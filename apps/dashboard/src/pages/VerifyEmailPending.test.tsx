// @vitest-environment jsdom
/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailVerificationRequestError } from '@/api/emailVerificationApi'
import { prepareEmailVerification } from '@/lib/auth-session'
import VerifyEmailPending from './VerifyEmailPending'

const mocks = vi.hoisted(() => ({
  resend: vi.fn(),
  signinSilent: vi.fn(),
  signinRedirect: vi.fn(),
  navigate: vi.fn(),
  emailVerified: false,
}))

vi.mock('@/api/emailVerificationApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/emailVerificationApi')>()
  return { ...original, resendEmailVerification: mocks.resend }
})

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: 'https://api.boxlite.test/api', oidc: { emailVerificationRequired: true } }),
}))

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    user: {
      access_token: 'pending-access-token',
      profile: {
        email: 'developer@example.com',
        email_verified: mocks.emailVerified,
      },
    },
    signinSilent: mocks.signinSilent,
    signinRedirect: mocks.signinRedirect,
  }),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  Navigate: ({ to }: { to: string }) => {
    mocks.navigate(to, { replace: true })
    return null
  },
}))

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('VerifyEmailPending', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    sessionStorage.clear()
    mocks.emailVerified = false
    mocks.resend.mockReset().mockResolvedValue(undefined)
    mocks.signinSilent.mockReset()
    mocks.signinRedirect.mockReset().mockResolvedValue(undefined)
    mocks.navigate.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  async function renderPage() {
    await act(async () => {
      root.render(<VerifyEmailPending />)
    })
    await flushReactWork()
  }

  it('auto-resends exactly once after a fresh unverified sign-in', async () => {
    prepareEmailVerification('/dashboard/billing', true)

    await renderPage()
    await act(async () => {
      root.render(<VerifyEmailPending />)
    })
    await flushReactWork()

    expect(mocks.resend).toHaveBeenCalledTimes(1)
    expect(mocks.resend).toHaveBeenCalledWith('https://api.boxlite.test/api', 'pending-access-token')
    expect(document.body.textContent).toContain('developer@example.com')
    expect(document.body.textContent).toContain('Verification email sent')
  })

  it('locks duplicate sends and applies the server Retry-After cooldown', async () => {
    vi.useFakeTimers()
    mocks.resend.mockRejectedValueOnce(new EmailVerificationRequestError('Please wait before trying again.', 429, 37))
    prepareEmailVerification('/dashboard', false)
    await renderPage()

    await act(async () => {
      button('Resend verification email').click()
      await Promise.resolve()
    })
    await flushReactWork()

    expect(mocks.resend).toHaveBeenCalledTimes(1)
    expect(button('Resend in 37s').disabled).toBe(true)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Please wait before trying again.')
  })

  it('refreshes the OIDC session and returns to the original page after verification', async () => {
    prepareEmailVerification('/dashboard/boxes?onboarding=1', false)
    mocks.signinSilent.mockResolvedValueOnce({ profile: { email_verified: true } })
    await renderPage()

    await act(async () => {
      button("I've verified my email").click()
      await Promise.resolve()
    })
    await flushReactWork()

    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/boxes?onboarding=1', { replace: true })
  })

  it('falls back to interactive authentication when silent refresh is unavailable', async () => {
    prepareEmailVerification('/dashboard/billing', false)
    mocks.signinSilent.mockRejectedValueOnce(new Error('login_required'))
    await renderPage()

    await act(async () => {
      button("I've verified my email").click()
      await Promise.resolve()
    })
    await flushReactWork()

    expect(mocks.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: '/dashboard/billing' } })
  })

  it('offers a route that signs out before switching accounts', async () => {
    prepareEmailVerification('/dashboard', false)
    await renderPage()

    act(() => button('Sign out and use another account').click())

    expect(mocks.navigate).toHaveBeenCalledWith('/logout')
  })
})

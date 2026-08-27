// @vitest-environment jsdom
/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundaryFallback } from './ErrorBoundaryFallback'
import { BoxliteError, EmailVerificationRequiredError, EMAIL_VERIFICATION_REQUIRED_CODE } from '@/api/errors'
import { RoutePath } from '@/enums/RoutePath'

let container: HTMLDivElement
let root: Root

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function render(error: unknown) {
  act(() => root.render(<ErrorBoundaryFallback error={error} resetErrorBoundary={vi.fn()} />))
  // The dialog portals out of `container`, so assert against the whole document.
  return document.body.textContent ?? ''
}

describe('ErrorBoundaryFallback', () => {
  it('offers verification, not a crash report, for an unverified email', () => {
    const text = render(new EmailVerificationRequiredError('Email verification required'))

    expect(text).toContain('Verify your email address')
    // The generic branch's furniture would be actively misleading here: this is
    // an account state the user can fix, not a fault to report.
    expect(text).not.toContain('Something went wrong')
    expect(text).not.toContain('Stack Trace')
  })

  it('sends the user through logout, the only path that can reach verification', () => {
    // Reloading or retrying replays the same unverified identity; ending the IdP
    // session is what lets the next sign-in render the hosted verification step.
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location)

    render(new EmailVerificationRequiredError('Email verification required'))

    const button = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Sign out and verify'),
    )
    // Narrows the type without a non-null assertion, and fails loudly if the
    // screen ever stops offering the only action that can clear the 403.
    if (!button) throw new Error('verification screen must offer a sign-out action')

    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(assign).toHaveBeenCalledWith(RoutePath.LOGOUT)
  })

  it('still shows the crash report for any other error', () => {
    const text = render(new BoxliteError('Runner is unreachable'))

    expect(text).toContain('Something went wrong')
    expect(text).toContain('Runner is unreachable')
    expect(text).not.toContain('Verify your email address')
  })

  // The API sends this literal (apps/api/src/exceptions/email-verification-required.exception.ts);
  // asserting the constant against itself would prove nothing, so pin the value.
  it('pins the wire code the API is expected to send', () => {
    expect(EMAIL_VERIFICATION_REQUIRED_CODE).toBe('email_verification_required')
  })
})

// @vitest-environment jsdom
/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { AuthProviderProps } from 'react-oidc-context'
import type { User } from 'oidc-client-ts'
import { ConfigProvider } from '../ConfigProvider'
import { getSignInIntent, markJustLoggedOut } from '@/lib/auth-session'
import { ORGANIZATION_SESSION_KEY } from '@/lib/organization-session'

const capture = vi.hoisted(() => ({ props: undefined as AuthProviderProps | undefined }))
vi.mock('@tanstack/react-query', () => ({
  useSuspenseQuery: () => ({ data: { oidc: { issuer: 'https://idp.example.test', clientId: 'console' } } }),
}))
vi.mock('react-oidc-context', async (original) => ({
  ...(await original<object>()),
  AuthProvider: (props: AuthProviderProps) => {
    capture.props = props
    return props.children
  },
}))

describe('account callback contract', () => {
  it('clears interactive account intent only with a user and keeps returnTo local', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    sessionStorage.clear()
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <ConfigProvider>
          <div />
        </ConfigProvider>,
      ),
    )
    const callback = capture.props!.onSigninCallback!
    markJustLoggedOut()
    await callback(undefined)
    expect(getSignInIntent()?.signedOut).toBe(true)
    await callback({ state: { returnTo: 'https://evil.example/dashboard' } } as User)
    expect(window.location.pathname).toBe('/dashboard')
    expect(getSignInIntent()).toBeNull()
    sessionStorage.setItem(ORGANIZATION_SESSION_KEY, 'renewal organization')
    await callback({ state: { returnTo: '/dashboard/keys?tab=active' } } as User)
    expect(window.location.pathname + window.location.search).toBe('/dashboard/keys?tab=active')
    expect(sessionStorage.getItem(ORGANIZATION_SESSION_KEY)).toBe('renewal organization')
    act(() => root.unmount())
  })
})

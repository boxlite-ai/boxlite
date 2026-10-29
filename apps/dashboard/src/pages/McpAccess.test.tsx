// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutePath } from '@/enums/RoutePath'
import McpAccess from './McpAccess'

const mocks = vi.hoisted(() => ({ user: { access_token: 'dashboard-token' }, signinRedirect: vi.fn(), fetch: vi.fn() }))
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: mocks.user, isAuthenticated: true, isLoading: false, signinRedirect: mocks.signinRedirect }),
}))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ apiUrl: '/api', oidc: { issuer: 'https://issuer.test/' } }),
}))

describe('McpAccess', () => {
  let container: HTMLDivElement
  let root: Root
  beforeAll(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    sessionStorage.clear()
    mocks.fetch.mockReset()
    vi.stubGlobal('fetch', mocks.fetch)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.querySelectorAll('form').forEach((form) => form.remove())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('links back to the registered API Keys page', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    await act(async () => {
      root.render(<McpAccess />)
    })
    const backLink = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Back to API Keys')
    expect(backLink?.getAttribute('href')).toBe(RoutePath.KEYS)
  })
  it('requires an organization choice and posts only selected scopes and the bound challenge', async () => {
    sessionStorage.setItem(
      'boxlite-mcp-consent',
      JSON.stringify({ challenge: 'signed', state: 'state', received: Date.now() }),
    )
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          client_name: 'Agent',
          client_id: 'client',
          scopes: ['boxes:read', 'boxes:write'],
          organizations: [{ id: 'org', name: 'Team', scopes: ['boxes:read', 'boxes:write'] }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          continue_url: 'https://issuer.test/continue',
          state: 'state',
          session_token: 'signed-continuation',
        }),
      })
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    await act(async () => {
      root.render(<McpAccess consent />)
    })
    const allow = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Allow access')!
    expect(allow.disabled).toBe(true)
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = 'org'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      allow.click()
    })
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      challenge: 'signed',
      state: 'state',
      organization_id: 'org',
      scopes: ['boxes:read'],
    })
    expect(submit).toHaveBeenCalledOnce()
    const form = document.querySelector('form')!
    expect(form.method).toBe('post')
    expect(form.action).toBe('https://issuer.test/continue')
    expect(sessionStorage.getItem('boxlite-mcp-consent')).toBeNull()
  })
  it('rejects expired browser state without sending a request', async () => {
    sessionStorage.setItem('boxlite-mcp-consent', JSON.stringify({ challenge: 'old', state: 'state', received: 0 }))
    await act(async () => {
      root.render(<McpAccess consent />)
    })
    expect(container.querySelector('[role=alert]')?.textContent).toContain('expired')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('revokes an existing grant and marks it revoked only after the API succeeds', async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'grant',
            client_name: 'Agent',
            organization_id: 'org',
            scopes: ['boxes:read'],
            expires_at: new Date().toISOString(),
            revoked_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true })
    await act(async () => {
      root.render(<McpAccess />)
    })
    await act(async () => {
      container.querySelector('button')!.click()
    })
    expect(mocks.fetch.mock.calls[1][0]).toBe('/api/mcp-consent/grants/grant')
    expect(mocks.fetch.mock.calls[1][1].method).toBe('DELETE')
    expect(container.querySelector('button')?.textContent).toBe('Revoked')
  })
})

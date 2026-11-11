// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CiAccountPicker } from './CiAccountPicker'
import type { CiConnectResult } from '@/api/ci-types'
import { prepareCiRedirect } from '@/lib/ci-connect'

describe('CI account state picker', () => {
  let root: Root
  const organization = '12345678-1234-4234-8234-123456789def',
    id = '12345678-1234-4234-8234-123456789abc'
  const api = { selectCiAccount: vi.fn(), getCiRepositories: vi.fn() },
    changed = vi.fn(),
    switched = vi.fn()
  const result: CiConnectResult = {
    id,
    status: 'selection_required',
    authenticated_account: 'alice',
    authorization_settings_url: 'https://github.com/settings/connections/applications/identity-client',
    accounts: [
      {
        account_id: 1,
        github_account: 'alice',
        account_type: 'User',
        installed: true,
        connected: false,
        installation_id: 11,
      },
      {
        account_id: 2,
        github_account: 'owned',
        account_type: 'Organization',
        installed: true,
        connected: false,
        installation_id: 12,
      },
      {
        account_id: 3,
        github_account: 'new-team',
        account_type: 'Organization',
        installed: false,
        connected: false,
        installation_id: null,
      },
      {
        account_id: 4,
        github_account: 'connected',
        account_type: 'Organization',
        installed: true,
        connected: true,
        installation_id: 14,
      },
    ],
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    api.selectCiAccount.mockReset()
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    document.body.innerHTML = ''
    sessionStorage.clear()
  })
  async function render(value = result) {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    await act(async () =>
      root.render(
        <StrictMode>
          <CiAccountPicker
            api={api}
            organization={organization}
            result={value}
            onResult={changed}
            onSwitch={switched}
          />
        </StrictMode>,
      ),
    )
  }
  const action = (account: number) =>
    [...document.querySelectorAll<HTMLButtonElement>(`[data-account-id="${account}"] button`)].find(
      (button) => button.textContent === 'Connect' || button.textContent === 'Install',
    )!
  it('shows Install, Connect and completed pixel checks according to server account state', async () => {
    await render()
    expect(action(1).textContent).toBe('Connect')
    expect(action(2).textContent).toBe('Connect')
    expect(action(3).textContent).toBe('Install')
    expect(action(4)).toBeUndefined()
    expect(document.querySelector('[data-account-id="4"] .text-success')?.textContent).toContain('Connected')
    expect(document.querySelectorAll('input[type=radio]')).toHaveLength(0)
    expect(document.body.textContent).toContain('Signed in as alice')
    expect(document.querySelector('summary')?.textContent).toBe('Missing an organization?')
  })
  it('offers repository disclosure for installed accounts without connecting them', async () => {
    await render()
    expect(document.querySelector('[data-account-id="2"] button[aria-label="Repositories for owned"]')).not.toBeNull()
    expect(document.querySelector('[data-account-id="3"] button[aria-label="Repositories for new-team"]')).toBeNull()
    expect(api.selectCiAccount).not.toHaveBeenCalled()
  })
  it('submits the chosen numeric account and policy once and displays the server acknowledgment', async () => {
    let finish!: (value: CiConnectResult) => void
    api.selectCiAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    await act(async () => document.querySelector<HTMLInputElement>('input')!.click())
    await act(async () => {
      action(2).click()
      action(2)?.click()
    })
    expect(api.selectCiAccount).toHaveBeenCalledExactlyOnceWith(organization, id, 2, true)
    expect(action(1).disabled).toBe(true)
    await act(async () => finish(result))
    expect(changed).toHaveBeenCalledExactlyOnceWith(result)
    expect(action(1).disabled).toBe(false)
  })
  it('keeps Switch account available during connection and ignores its late result', async () => {
    let finish!: (value: CiConnectResult) => void
    api.selectCiAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await render()
    await act(async () => action(1).click())
    const switchButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Switch account',
    )!
    expect(switchButton.disabled).toBe(false)
    await act(async () => switchButton.click())
    expect(switched).toHaveBeenCalledExactlyOnceWith(true)
    await act(async () => finish(result))
    expect(changed).not.toHaveBeenCalled()
  })
  it('offers OAuth approval and SSO recovery when a successful inventory omits an organization', async () => {
    await render({ ...result, accounts: result.accounts!.slice(0, 1) })
    expect(document.body.textContent).toContain('approve OAuth access')
    expect(document.body.textContent).toContain('sign in with SSO')
    expect(document.querySelector('a')?.href).toBe(result.authorization_settings_url)
    expect(document.body.textContent).not.toContain('No organizations')
    const reconnect = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reconnect GitHub',
    )!
    await act(async () => reconnect.click())
    expect(switched).toHaveBeenCalledExactlyOnceWith(false)
  })
  it('refuses an outside installation URL and provides recovery after a failed selection', async () => {
    prepareCiRedirect(organization, {
      id,
      authorization_url: 'https://github.com/login/oauth/authorize?state=' + id + '.' + 'A'.repeat(43),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    })
    api.selectCiAccount.mockResolvedValue({
      status: 'installation_required',
      installation_url: 'https://outside.test/collect',
    })
    await render()
    await act(async () => action(3).click())
    expect(changed).not.toHaveBeenCalled()
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Reconnect GitHub')
    expect(action(3).disabled).toBe(false)
  })
})

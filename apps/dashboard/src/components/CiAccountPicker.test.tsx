// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CiAccountPicker } from './CiAccountPicker'
afterEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
})
it('requires an explicit account selection and submits once while a request is pending', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let finish!: (value: { status: string }) => void
  const api = {
      selectCiConnect: vi.fn(
        () =>
          new Promise<{ status: string }>((resolve) => {
            finish = resolve
          }),
      ),
    },
    changed = vi.fn()
  const result = {
    id: 'attempt',
    status: 'selection_required',
    installation_url: 'https://github.com/apps/test/installations/new?state=original',
    accounts: [
      { installation_id: 123, account_id: 456, github_account: 'alice', account_type: 'User' as const },
      { installation_id: 124, account_id: 789, github_account: 'team', account_type: 'Organization' as const },
    ],
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  sessionStorage.setItem('boxlite.ci.connect', JSON.stringify({ attempt: 'attempt', organization: 'tenant' }))
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <CiAccountPicker api={api} organization="tenant" result={result} onResult={changed} />
        </StrictMode>,
      ),
    )
    const radios = document.querySelectorAll<HTMLInputElement>('input[type=radio]'),
      button = document.querySelector<HTMLButtonElement>('button')!
    expect(radios).toHaveLength(2)
    expect([...radios].every((input) => !input.checked)).toBe(true)
    expect(button.disabled).toBe(true)
    expect(api.selectCiConnect).not.toHaveBeenCalled()
    await act(async () => radios[1].click())
    const submit = () =>
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await act(async () => {
      submit()
      submit()
    })
    expect(api.selectCiConnect).toHaveBeenCalledExactlyOnceWith('tenant', 'attempt', 124)
    expect(button.disabled).toBe(true)
    await act(async () => finish({ status: 'connected' }))
    expect(changed).toHaveBeenCalledExactlyOnceWith({ status: 'connected' })
    expect(sessionStorage.getItem('boxlite.ci.connect')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

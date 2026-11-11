// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Keys from './Keys'

const state = vi.hoisted(() => ({
  keys: ['crm_key', 'quickstart', 'quickstart-agent'].map((name) => ({
    name,
    userId: 'user-1',
    value: 'blk_live_********',
    permissions: [],
    createdAt: '2026-11-01T00:00:00Z',
    lastUsedAt: null,
    expiresAt: null,
  })),
  revoke: vi.fn(),
}))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ apiUrl: 'https://api.example.test' }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1' },
    authenticatedUserOrganizationMember: { role: 'owner', assignedRoles: [] },
  }),
}))
vi.mock('@/hooks/queries/useApiKeysQuery', () => ({ useApiKeysQuery: () => ({ data: state.keys }) }))
vi.mock('@/hooks/mutations/useRevokeApiKeyMutation', () => ({
  useRevokeApiKeyMutation: () => ({ mutateAsync: state.revoke }),
}))
vi.mock('@/components/CreateApiKeyDialog', () => ({ CreateApiKeyDialog: () => <button>Create Key</button> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

let root: Root
const initialKeys = [...state.keys]

/** Renders the real page and table with data provided at the query boundary. */
async function render() {
  await act(async () => root.render(<Keys />))
}

/** Enters a query through the visible filter's normal input event. */
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter API keys"]')
  expect(input, 'API keys must expose the shared list filter').not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  state.keys = [...initialKeys]
  state.revoke.mockReset().mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('API key list filter', () => {
  it('matches names ignoring case and surrounding whitespace, and counts visible results', async () => {
    await render()
    const input = await search('  QUICKSTART  ')
    expect(document.body.textContent).not.toContain('crm_key')
    expect(document.body.textContent).toContain('quickstart-agent')
    expect(input?.parentElement?.textContent).toContain('2')
    expect(document.querySelectorAll('button[aria-label="Revoke key"]')).toHaveLength(2)
  })

  it('distinguishes no matches from first-use empty state and restores rows when cleared', async () => {
    await render()
    await search('missing')
    expect(document.body.textContent).toContain('No API keys match your search')
    expect(document.body.textContent).not.toContain('Create a key to get started.')
    const clear = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Clear filter')
    expect(clear).toBeTruthy()
    await act(async () => clear?.click())
    expect(document.querySelectorAll('button[aria-label="Revoke key"]')).toHaveLength(3)
  })

  it('keeps the first-use guidance when there are no keys and no filter', async () => {
    state.keys = []
    await render()
    expect(document.body.textContent).toContain('Create a key to get started.')
    expect(document.body.textContent).not.toContain('No API keys match your search')
  })

  it('revokes the matching key after filtering without changing its identity', async () => {
    await render()
    await search('CRM')
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Revoke key"]')?.click())
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Revoke')
    await act(async () => confirm?.click())
    expect(state.revoke).toHaveBeenCalledWith({ userId: 'user-1', name: 'crm_key', organizationId: 'org-1' })
  })
})
